# Image Generation

Generate images directly in chat using Pi 1.6's native `codemode` image API (`models.generateImages()`). Pi reuses your session's configured provider credentials, tracks cost automatically, and adds zero top-level tool schema tokens when you are not generating images.

> **Migration note:** The standalone `extensions/image-gen/` extension (`generate_image`) and `image_model` / `PI_IMAGE_MODEL` setting were retired now that Pi 1.6.1 provides native image generation inside `codemode`. Any legacy `image_model` key left in `.pi/pi-config-settings.json` or `~/.pi/pi-config-settings.json` is ignored safely.

## Prerequisites

- `pi` >= 1.6.1 with `codemode` enabled
- Credentials for any provider in Pi's model catalog that exposes an image model (for example Google/Gemini, OpenRouter, or OpenAI)

## Quick Example

Ask in plain language:

```text
Generate a watercolor image of a red fox in the snow.
```

Pi runs a `codemode` script that discovers an available image model, generates the image, displays it via `image(block)`, and returns the saved temp file path:

```js
// @options: {"timeout_ms": 300000}
const available = await models.getAvailableOfType("image");
if (available.length === 0) return "No image model available for the configured providers.";

const result = await models.generateImages(available[0], {
  input: [{ type: "text", text: "A red fox in the snow, watercolor" }],
});
if (result.stopReason !== "stop") return result.errorMessage ?? "Image generation failed.";

for (const block of result.output) {
  if (block.type === "image") image(block);
  else text(block.text);
}
```

## Reference Images and Edits

Pass existing images alongside text prompts by reading them with `tools.read()`:

```js
// @options: {"timeout_ms": 300000}
const available = await models.getAvailableOfType("image");
const ref = await tools.read({ path: "mockup.png" });
const result = await models.generateImages(available[0], {
  input: [
    ref,
    { type: "text", text: "Make the background dark slate with subtle grid lines" },
  ],
});
if (result.stopReason !== "stop") return result.errorMessage ?? "Image edit failed.";
for (const block of result.output) {
  if (block.type === "image") image(block);
  else text(block.text);
}
```

## Notes

- **Timeouts:** Image generation can take minutes. Set `// @options: {"timeout_ms": 300000}` on the first line of the `codemode` script instead of a short deadline.
- **Output handling:** Always pass generated image blocks to `image(block)` — it displays the image and writes a temp file whose path is returned in the tool result. Never pass raw base64 `block.data` to `text()`, `console.log()`, or `return`.
- **Selecting a specific model:** Use `models.getModelOfType("image", provider, id)` when you want a specific provider/model instead of `available[0]`.
