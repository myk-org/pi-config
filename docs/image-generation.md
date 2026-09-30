# Image Generation

Set up Gemini once, then ask Pi to create images directly in chat so you can produce mockups, concept art, and visual assets without leaving your development session. You should be able to go from API key to saved image in a minute.

Images are produced by the `generate_image` tool registered in `extensions/image-gen/`. It calls the Gemini `generateContent` REST endpoint directly (`https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`) with `responseModalities: ["IMAGE"]`. There is no slash command to learn — you just ask for an image in plain language.

## Prerequisites

- A Gemini API key in `GEMINI_API_KEY` or `GOOGLE_API_KEY`
- An image-capable Gemini model set with `PI_IMAGE_MODEL` or in `.pi/pi-config-settings.json`
- An active Pi session

## Quick Example

```bash
export GEMINI_API_KEY="your-api-key"
export PI_IMAGE_MODEL="gemini-3-pro-image"
```

```text
Generate a pixel art image of a cat hacking on a mechanical keyboard.
```

Pi replies with the saved file path under your project's `.pi/tmp/` directory. In container-based sessions, Pi also includes a clickable `http://localhost:<port>/<filename>` preview URL.

## Step-by-step

1. **Set the model**

   The easiest way is the settings picker, which filters to Google/Gemini models that can output images:

   ```text
   /pi-config-settings
   ```

   Set `image_model` there, save, and reload Pi.

   Or for the current shell:

   ```bash
   export PI_IMAGE_MODEL="gemini-3-pro-image"
   ```

   Or save it in your project settings:

   ```json
   {
     "image_model": "gemini-3-pro-image"
   }
   ```

   Save that JSON in `.pi/pi-config-settings.json`.

   > **Note:** The model id must look like a Gemini image model. Pi refuses ids that contain none of `imagen`, `image-generation`, or `image` as a delimited token — for example `gemini-3-pro-image`, `gemini-2.0-flash-preview-image-generation`, or `imagen-3.0-generate-002` are accepted, while a text-only model such as `gemini-2.5-pro` is rejected before any API call.

2. **Set the API key**

   ```bash
   export GEMINI_API_KEY="your-api-key"
   ```

   If you already use `GOOGLE_API_KEY`, that works too.

3. **Ask for the image in plain language**

   ```text
   Generate an image of a coffee cup spilling over on a futuristic desk.
   ```

   You do not need a special slash command. A normal request is enough.

4. **Open the result**

   Pi returns one or more saved file paths such as:

   ```text
   /your-project/.pi/tmp/pi-image-123456-abcd12.png
   ```

   If your session is running in a container, Pi also prints a localhost preview link for the same file.

> **Tip:** Keep the model in `.pi/pi-config-settings.json` if you want the same default across sessions, and keep the API key in your shell environment.

## Advanced Usage

### Use structured prompt fields

When you want tighter control over composition, ask with named fields:

```text
Generate an image. Subject: A coffee cup. Action: spilling over. Scene: A busy futuristic desk. Composition: close-up. Lighting: neon glow. Style: photorealistic. Text: "ERROR 404". Aspect ratio: 16:9.
```

These map one-to-one onto the `generate_image` tool parameters. `subject` is required; the rest are optional:

- `subject` (required)
- `action`
- `scene`
- `composition`
- `lighting`
- `style`
- `text`
- `aspect_ratio`

Use this format when a short natural-language prompt is not specific enough. Pi joins the supplied fields into a single prose prompt and appends `Text: <text>` on its own line when `Text` is set.

### Supported aspect ratios

Use one of these exact values when you want a specific canvas shape:

| Value | Best for |
|---|---|
| `1:1` | Square avatars, icons, thumbnails |
| `3:4` | Portrait images |
| `4:3` | Standard landscape images |
| `9:16` | Mobile and story-style images |
| `16:9` | Widescreen banners and mockups |

If you omit `Aspect ratio`, Pi sends the request without one and lets the model use its default output shape.

### Know what file types to expect

Pi saves whatever image format Gemini returns, mapping the response MIME type to an extension:

| MIME type | Extension |
|---|---|
| `image/png` | `.png` |
| `image/jpeg` | `.jpg` |
| `image/gif` | `.gif` |
| `image/webp` | `.webp` |
| anything else | `.png` (fallback) |

Files are named `pi-image-<epoch-ms>-<6-char-random>.<ext>` under `<cwd>/.pi/tmp/`. If a request returns multiple images, Pi lists every saved path in the response. A part with empty or undecodable base64 is skipped rather than failing the whole call.

### Work smoothly in containers

In Docker or Podman-style sessions (detected via `/.dockerenv`, `/run/.containerenv`, or a `docker`/`containerd` cgroup), Pi automatically serves generated images over HTTP so you can open them outside the container. You do not need to start a separate preview command.

The preview needs `uv` on `PATH`, because it runs `scripts/httpd.py` from the installed package. One server is started per call and serves the whole `.pi/tmp/` directory, so every saved path in the response gets its own `Preview:` line. Outside a container no preview server is started and only the file path is returned.

See [Configuration & Settings](configuration.html) for the full settings reference and [Installation & Quickstart](quickstart.html) for general setup.

## Troubleshooting

- **"image model is not set"**  
  Set `PI_IMAGE_MODEL` or add `"image_model": "gemini-3-pro-image"` to `.pi/pi-config-settings.json`, then restart Pi.

- **"image_model '&lt;id&gt;' is not an image-generation model"**  
  The id does not look like a Gemini image model. Pick one from `/pi-config-settings`, which only lists Google image-capable models for this setting.

- **"No API key found"**  
  Export `GEMINI_API_KEY` or `GOOGLE_API_KEY` before starting Pi. Keys are read from the process environment only and never from settings files.

- **"Image generation blocked by safety filter"**  
  Gemini returned a `promptFeedback.blockReason`. Rephrase the prompt to remove unsafe or explicit content.

- **"No image data returned from Gemini"**  
  The call succeeded but carried no `inlineData` part. Retry with a simpler prompt, or switch to a different image-capable Gemini model.

- **"Gemini image request failed (4xx/5xx)"**  
  Check that the key is valid and the Generative Language API is enabled. `401`/`403` means the key is wrong or lacks access; `404` usually means the model id does not exist for that key.

- **The request hangs**  
  When Pi passes no abort signal, the request carries a 3-minute timeout. Very complex prompts at large aspect ratios can hit it; simplify and retry.

> **Warning:** Pi reads the API key from the current session environment, so export it before launching Pi.

## Related Pages

- [Configuration & Settings](configuration.html)
- [Installation & Quickstart](quickstart.html)
- [External AI Agents & CLI](external-ai-agents.html)
- [Google Vertex Claude Provider](vertex-claude-provider.html)
