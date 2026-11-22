// Port of backend/app/services/cron/module_service.py — start/stop the cron
// scheduler with the app lifespan.
import { getCronService } from "./service.js";

export async function startCron(): Promise<void> {
  await getCronService().start();
}

export async function stopCron(): Promise<void> {
  await getCronService().stop();
}
