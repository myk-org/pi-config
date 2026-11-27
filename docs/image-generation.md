# Image Generation

Generate images directly in chat using Pi's native `codemode` image API (`models.generateImages()`). Pi reuses your session's configured provider credentials, tracks cost automatically, and adds zero top-level tool schema tokens when you are not generating images.

> **Migration note:** The standalone `extensions/image-gen/` extension (`generate_image`) and `image_model` / `PI_IMAGE_MODEL` setting were retired now that Pi 1.6.1+ provides native image generation inside `codemode`. Any legacy `image_model` key left in `.pi/pi-config-settings.json` or `~/.pi/pi-config-settings.json` is ignored safely.

## Prerequisites

- `pi` >= 1.6.1 (`pi` >= 1.7.0 for `{ aspectRatio, size }` options and Radius built-in image and classifier models; `pi-config` activates `codemode` automatically on `session_start` in default sessions unless excluded with `--no-tools`, `--exclude-tools`, `--tools -codemode`, or `defaultTools`)
- Credentials for a provider in Pi's model catalog that exposes an image model, such as OpenRouter (for example `google/gemini-2.5-flash-image` or `black-forest-labs/flux.2-pro`) or Radius (when enabled for the organization)

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
const editor = available.find((m) => Array.isArray(m.input) && m.input.includes("image"));
if (!editor) return "No available image model accepts image input for reference edits.";

const ref = await tools.read({ path: "mockup.png" });
const result = await models.generateImages(editor, {
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

## Aspect Ratio and Resolution (Pi 1.7.0+)

Pass an optional third `options` object to `models.generateImages(model, context, options)` to request a specific aspect ratio or resolution on OpenRouter image models:

```js
// @options: {"timeout_ms": 300000}
const available = await models.getAvailableOfType("image", "openrouter");
if (available.length === 0) return "No OpenRouter image model is available.";

const result = await models.generateImages(
  available[0],
  { input: [{ type: "text", text: "A red fox in the snow, watercolor" }] },
  { aspectRatio: "16:9", size: "2K" },
);
if (result.stopReason !== "stop") return result.errorMessage ?? "Image generation failed.";

for (const block of result.output) {
  if (block.type === "image") image(block);
  else text(block.text);
}
```

- `aspectRatio`: ratio string such as `"1:1"`, `"16:9"`, `"4:3"`, or `"9:16"`.
- `size`: resolution tier `"1K"`, `"2K"`, or `"4K"`. Pixel dimensions like `"1024x1536"` are not supported.
- Options pass through to the provider unchanged. Unsupported values return an error `stopReason`, and unknown option keys throw.

## Notes

- **Timeouts:** Image generation can take minutes. Set `// @options: {"timeout_ms": 300000}` on the first line of the `codemode` script instead of a short deadline.
- **Output handling:** Always pass generated image blocks to `image(block)`. It displays the image and writes a temp file whose path is returned in the tool result. Never pass raw base64 `block.data` to `text()`, `console.log()`, or `return`.
- **Selecting a specific model:** Use `models.getModelOfType("image", provider, id)` when you want a specific provider/model instead of `available[0]`.
- **Radius models (Pi 1.7.0+):** Pi's built-in catalog and provider discovery include Radius image and classifier models when Radius is enabled for your organization. Discover them dynamically with `models.getAvailableOfType("image")` and `models.getAvailableOfType("classifier")`.
