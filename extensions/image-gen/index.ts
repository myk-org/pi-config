/**
 * Image Generation Extension for pi
 *
 * Registers a `generate_image` tool that generates images via Gemini API.
 * Requires image_model in pi-config-settings.json (or PI_IMAGE_MODEL) and
 * GEMINI_API_KEY/GOOGLE_API_KEY environment variables.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createImageGenTool } from "./image-gen.js";

export default function (pi: ExtensionAPI) {
    pi.registerTool(createImageGenTool());
}
