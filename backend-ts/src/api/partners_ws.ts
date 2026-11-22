// Port of the partner / partner-group WebSocket protocols:
// mounted under /ws by the manifests, i.e. /ws/partners/{id} and
// /ws/partner-groups/{id}.
//
// These are transport adapters: all domain logic lives in
// services/partners_ext (PartnerManager live turns + PartnerGroupManager
// LiveGroupTurn). Frame shapes match upstream exactly — the web frontend
// consumes them verbatim.
//
// Auth: upstream requires a PocketBase token (?token= / cookie). This backend
// is auth-free; the caller is resolved from ?user_id= (tests / guardian flows)
// and defaults to the seeded admin, same convention as partners_full.ts.

import type { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";

import {
  canManagePartner,
  canUsePartner,
  currentUser,
  personalActorId,
  webSessionKey,
  FrameQueue,
  getPartnerManager,
  PartnerNotFoundError,
  PartnerStaleSessionError,
  PartnerTurnBusyError,
  type LiveTurn,
} from "../services/partners_ext/manager.js";
import {
  getPartnerGroupManager,
  LiveGroupTurn,
} from "../services/partners_ext/groups.js";
import type { CurrentUser } from "../services/partners_ext/multiuser.js";
import type { AnyRecord } from "../services/partners_ext/store.js";
import {
  defaultAttachmentPrompt,
  materializeAttachments,
} from "./partners_full.js";

function wsUser(req: IncomingMessage): CurrentUser {
  const url = new URL(req.url ?? "/", "http://localhost");
  return currentUser(url.searchParams.get("user_id"));
}

function asRecord(v: unknown): AnyRecord {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as AnyRecord) : {};
}

function asRecordList(v: unknown): AnyRecord[] {
  return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") as AnyRecord[] : [];
}

// ════════════════════════════════════════════════════════════════
// /ws/partners/{partner_id} — partner_chat_ws
// ════════════════════════════════════════════════════════════════

export async function handlePartnerWs(
  ws: WebSocket,
  req: IncomingMessage,
  partnerId: string,
): Promise<void> {
  const user = wsUser(req);
  const mgr = getPartnerManager();

  // Unknown partner / no access close identically (upstream 4404).
  if (!mgr.partnerExists(partnerId) || !canUsePartner(partnerId, mgr.ownerId(partnerId), user)) {
    try { ws.close(4404); } catch { /* closed */ }
    return;
  }

  let disconnected = false;
  const safeSend = async (payload: AnyRecord): Promise<boolean> => {
    if (disconnected) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      disconnected = true;
      return false;
    }
  };

  let instance;
  try {
    instance = await mgr.ensureRunning(partnerId, { allow_stopped: true });
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc);
    await safeSend({ type: "error", content: message });
    const code = exc instanceof PartnerNotFoundError ? 4004 : 4003;
    try { ws.close(code, message.slice(0, 120)); } catch { /* closed */ }
    return;
  }

  if (!(await safeSend({ type: "ready" }))) return;

  // ── turn drain (upstream _drain/_start_drain) ──
  // The turn runs on the partner instance; the socket just drains a
  // subscriber queue so a refresh can reattach and replay.
  let drainQueue: FrameQueue | null = null;
  let drainLive: LiveTurn | null = null;

  const stopDrain = () => {
    if (drainLive && drainQueue) drainLive.unsubscribe(drainQueue);
    else drainQueue?.close();
    drainQueue = null;
    drainLive = null;
  };

  const startDrain = (turn: LiveTurn) => {
    stopDrain();
    const queue = turn.subscribe();
    drainQueue = queue;
    drainLive = turn;
    void (async () => {
      while (true) {
        const frame = await queue.get();
        if (frame === null) return; // unsubscribed/closed
        if (!(await safeSend(frame))) return;
        const t = String(frame["type"] ?? "");
        if (t === "done" || t === "stopped") return;
      }
    })();
  };

  // ── cross-channel activity feed (upstream attach include_activity) ──
  let activityQueue: FrameQueue | null = null;
  const activityActorId = personalActorId(user);
  const activityActorIds: Array<string | null> =
    activityActorId !== null && canManagePartner(mgr.ownerId(partnerId), user)
      ? [activityActorId, null]
      : [activityActorId];

  const resolveKey = (data: AnyRecord): string =>
    String(
      data["session_key"] ||
        webSessionKey(partnerId, {
          chat_id: data["chat_id"] === undefined ? "web" : String(data["chat_id"]),
          session_id: data["session_id"] === undefined ? undefined : String(data["session_id"]),
        }),
    );

  const onMessage = async (raw: string) => {
    let data: AnyRecord;
    try {
      data = asRecord(JSON.parse(raw));
    } catch {
      await safeSend({ type: "error", content: "Invalid JSON" });
      return;
    }

    const action = data["action"];
    if (action === "stop") {
      mgr.stopWebTurn(partnerId, resolveKey(data));
      return;
    }
    if (action === "attach") {
      // The same attachment that follows the history request also starts the
      // cross-channel activity feed (replays a bounded recent window).
      if (activityQueue === null && data["include_activity"] !== false) {
        activityQueue = instance.activityFeed.subscribeMany(activityActorIds);
        void (async () => {
          const queue = activityQueue!;
          while (true) {
            const frame = await queue.get();
            if (frame === null) return;
            if (!(await safeSend(frame))) return;
          }
        })();
      }
      // Reconnect (page refresh) — replay an in-flight turn.
      const turn = mgr.subscribeWebTurn(partnerId, resolveKey(data));
      if (turn) {
        await safeSend({ type: "resuming" });
        if (turn.userContent) await safeSend({ type: "user_echo", content: turn.userContent });
        startDrain(turn);
      } else {
        const key = resolveKey(data);
        const frameType = mgr.webSessionIsBusy(partnerId, key) ? "attach_busy" : "attach_idle";
        await safeSend({ type: frameType, session_key: key });
      }
      return;
    }

    const content = String(data["content"] ?? "").trim();
    const attachments = asRecordList(data["attachments"]);
    if (!content && !attachments.length) return;
    // Light ChatAttachmentRequest validation: dicts only.
    if (data["attachments"] !== undefined && data["attachments"] !== null && !Array.isArray(data["attachments"])) {
      await safeSend({ type: "error", content: "Invalid attachments" });
      return;
    }

    let mediaPaths: string[];
    try {
      mediaPaths = materializeAttachments(partnerId, attachments);
    } catch (exc) {
      await safeSend({ type: "error", content: exc instanceof Error ? exc.message : String(exc) });
      return;
    }
    const finalContent = content || (mediaPaths.length ? defaultAttachmentPrompt(attachments) : "");

    const sessionKey = resolveKey(data);
    let turn: LiveTurn;
    try {
      turn = mgr.startWebTurn(partnerId, sessionKey, finalContent, mediaPaths, {
        account_id: user.id,
        actor: user,
      });
    } catch (exc) {
      if (exc instanceof PartnerStaleSessionError) {
        await safeSend({
          type: "stale_session",
          content: String(exc.message),
          active_session_key: exc.activeSessionKey,
        });
      } else if (exc instanceof PartnerTurnBusyError) {
        await safeSend({ type: "turn_busy", content: exc.message });
      } else {
        await safeSend({ type: "error", content: exc instanceof Error ? exc.message : String(exc) });
      }
      return;
    }
    // Admission is distinct from execution: clients must not restore the
    // question as a rejected draft.
    if (!(await safeSend({ type: "accepted", session_key: sessionKey }))) return;
    startDrain(turn);
  };

  ws.on("message", (data) => {
    void onMessage(String(data)).catch((e) => {
      console.error("[partners_ws] message handler error:", e);
      disconnected = true;
    });
  });
  const cleanup = () => {
    disconnected = true;
    stopDrain();
    if (activityQueue) {
      instance.activityFeed.unsubscribeMany(activityActorIds, activityQueue);
      activityQueue = null;
    }
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

// ════════════════════════════════════════════════════════════════
// /ws/partner-groups/{group_id} — partner_group_ws
// ════════════════════════════════════════════════════════════════

let wsClientSeq = 0;

export async function handlePartnerGroupWs(
  ws: WebSocket,
  _req: IncomingMessage,
  groupId: string,
): Promise<void> {
  const user = wsUser(_req);
  const manager = getPartnerGroupManager();
  if (manager.getGroup(groupId) === null) {
    try { ws.close(4404); } catch { /* closed */ }
    return;
  }

  // Serialize outbound frames (upstream send_lock).
  let sendChain: Promise<void> = Promise.resolve();
  const send = (frame: AnyRecord): Promise<void> => {
    sendChain = sendChain.then(() =>
      new Promise<void>((resolve) => {
        try {
          ws.send(JSON.stringify(frame), () => resolve());
        } catch {
          resolve();
        }
      }),
    );
    return sendChain;
  };

  const pushTasks = new Map<number, Promise<void>>();
  const subscriptions = new Set<{ live: LiveGroupTurn; queue: FrameQueue }>();
  let pushSeq = 0;
  const consultationClient = `ws-${++wsClientSeq}`;
  const consultationSessions = new Set<string>();

  const pushLive = async (sub: { live: LiveGroupTurn; queue: FrameQueue }) => {
    try {
      while (true) {
        const frame = await sub.queue.get();
        if (frame === null) return;
        await send(frame);
        const t = String(frame["type"] ?? "");
        if (t === "done" || t === "error" || t === "cancelled") return;
      }
    } finally {
      sub.live.unsubscribe(sub.queue);
      subscriptions.delete(sub);
    }
  };

  const attach = (live: LiveGroupTurn) => {
    const sub = { live, queue: live.subscribe() };
    subscriptions.add(sub);
    const id = ++pushSeq;
    const task = pushLive(sub).catch(() => {});
    pushTasks.set(id, task);
    void task.finally(() => pushTasks.delete(id));
  };

  const onMessage = async (raw: string) => {
    let data: AnyRecord;
    try {
      data = asRecord(JSON.parse(raw));
    } catch {
      await send({ type: "error", content: "Invalid Group message" });
      return;
    }
    const sessionKey = String(data["session_key"] || "default").slice(0, 120);
    const action = String(data["action"] || "");
    if (action === "consultation_activity") {
      consultationSessions.add(sessionKey);
      manager.consultationActivity(groupId, sessionKey, consultationClient, {
        has_draft: data["has_draft"] === true,
        active: data["active"] === true,
      });
      return;
    }
    if (action !== "attach") {
      manager.consultationActivity(groupId, sessionKey, consultationClient);
    }

    if (action === "attach") {
      for (const live of manager.subscribeLiveTurns(groupId, sessionKey, user)) {
        attach(live);
      }
      return;
    }

    let live: LiveGroupTurn;
    try {
      switch (action) {
        case "create_invocation": {
          const invocation = manager.createInvocation(groupId, {
            session_key: sessionKey,
            requester_partner_id: String(data["requester_partner_id"] || ""),
            target_partner_id: String(data["target_partner_id"] || ""),
            question: String(data["question"] || ""),
          });
          await send({ type: "invocation_updated", invocation: invocation as unknown as AnyRecord });
          return;
        }
        case "approve_invocation":
          live = manager.startLiveInvocation(groupId, {
            invocation_id: String(data["invocation_id"] || ""),
            session_key: sessionKey,
            user,
          });
          break;
        case "reject_invocation": {
          const invocation = manager.rejectInvocation(groupId, String(data["invocation_id"] || ""), {
            session_key: sessionKey,
          });
          await send({ type: "invocation_updated", invocation: invocation as unknown as AnyRecord });
          return;
        }
        case "retry_partner":
          live = manager.startLiveRetry(groupId, {
            turn_id: String(data["turn_id"] || ""),
            partner_id: String(data["partner_id"] || ""),
            session_key: sessionKey,
            user,
          });
          break;
        case "summarize_round":
          live = manager.startLiveSummary(groupId, {
            turn_id: String(data["turn_id"] || ""),
            partner_id: String(data["partner_id"] || ""),
            session_key: sessionKey,
            user,
          });
          break;
        case "cancel": {
          const cancelled = manager.cancelLiveTurn(groupId, sessionKey, {
            invocation_id: String(data["invocation_id"] || ""),
            user,
          });
          attach(cancelled);
          await send({
            type: "cancel_requested",
            operation: cancelled.operation,
            invocation_id: cancelled.invocation_id,
          });
          return;
        }
        default: {
          // PartnerGroupMessageRequest: {content, session_key?, mentions?}
          const content = String(data["content"] ?? "").trim();
          const mentionsRaw = data["mentions"];
          if (!content) {
            await send({ type: "error", content: "Invalid Group message" });
            return;
          }
          const mentions = Array.isArray(mentionsRaw)
            ? mentionsRaw.map((m) => String(m))
            : null;
          live = manager.startLiveTurn(groupId, {
            content,
            session_key: sessionKey,
            mentions,
            user,
          });
        }
      }
    } catch (exc) {
      await send({ type: "error", content: exc instanceof Error ? exc.message : String(exc) });
      return;
    }
    // Push frames in a separate task so this receive loop stays able to
    // approve/reject/cancel while Partners are still running.
    attach(live);
  };

  ws.on("message", (data) => {
    void onMessage(String(data)).catch(() => {});
  });
  const detachAll = () => {
    for (const sub of subscriptions) sub.live.unsubscribe(sub.queue);
    subscriptions.clear();
  };
  ws.on("close", () => {
    for (const key of consultationSessions) {
      manager.disconnectConsultation(groupId, key, consultationClient);
    }
    // Detach from the streams only — turns keep running so a reconnecting
    // client can reattach and replay them.
    detachAll();
  });
  ws.on("error", () => {
    for (const key of consultationSessions) {
      manager.disconnectConsultation(groupId, key, consultationClient);
    }
    detachAll();
  });
}
