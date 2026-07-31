# Image Generation

Set up Gemini once, then ask Pi to create images directly in chat so you can produce mockups, concept art, and visual assets without leaving your development session. You should be able to go from API key to saved image in a minute.

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

   For the current shell:

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

These fields are supported:

- `Subject`
- `Action`
- `Scene`
- `Composition`
- `Lighting`
- `Style`
- `Text`
- `Aspect ratio`

Use this format when a short natural-language prompt is not specific enough.

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

Pi saves whatever image format Gemini returns. Current output formats include:

- `.png`
- `.jpg`
- `.gif`
- `.webp`

If a request returns multiple images, Pi lists every saved path in the response.

### Work smoothly in containers

In Docker or Podman-style sessions, Pi automatically serves generated images over HTTP so you can open them outside the container. You do not need to start a separate preview command.

See [Configuration & Settings](configuration.html) for the full settings reference and [Installation & Quickstart](quickstart.html) for general setup.

## Troubleshooting

- **"Model not configured"**  
  Set `PI_IMAGE_MODEL` or add `"image_model": "gemini-3-pro-image"` to `.pi/pi-config-settings.json`, then restart Pi.

- **"No API key found"**  
  Export `GEMINI_API_KEY` or `GOOGLE_API_KEY` before starting Pi.

- **"Image generation blocked by safety filter"**  
  Rephrase the prompt to remove unsafe or explicit content.

- **"No image data returned from Gemini"**  
  Retry with a simpler prompt or switch to a different image-capable Gemini model.

> **Warning:** Pi reads the API key from the current session environment, so export it before launching Pi.

## Related Pages

- [Configuration & Settings](configuration.html)
- [Installation & Quickstart](quickstart.html)
- [External AI Agents & CLI](external-ai-agents.html)
- [Google Vertex Claude Provider](vertex-claude-provider.html)
