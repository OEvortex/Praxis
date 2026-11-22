import { read_layers } from "../src/services/calendar/layers.js";
const now = Date.now();
const layers = await read_layers("", now - 86400000, now + 86400000, "UTC");
console.log("read_layers ok:", JSON.stringify({
  reviews: layers.reviews.length,
  automations: layers.automations.length,
  footprints: layers.footprints.length,
}));
