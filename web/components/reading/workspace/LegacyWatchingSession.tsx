"use client";
import { useEffect, useState } from "react";
import { useRouter } from "@/shared/router/navigation";

import { migrateWatchingSession } from "@/lib/session-api";
import { sessionRoute } from "@/lib/mastery-session";

export default function LegacyWatchingSession({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    migrateWatchingSession(sessionId).then(session => {
      if (!cancelled) router.replace(sessionRoute({ ...session, message_count: session.messages.length, last_message: session.messages.at(-1)?.content ?? "" }), { scroll: false });
    }).catch(caught => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load this section.");
    });
    return () => { cancelled = true; };
  }, [sessionId, router, retry]);
  return <div className="p-6 text-sm" role={error ? "alert" : "status"}>
    {error || "Loading…"}
    {error && <button type="button" className="ml-3 underline" onClick={() => { setError(""); setRetry(value => value + 1); }}>{"Retry"}</button>}
  </div>;
}
