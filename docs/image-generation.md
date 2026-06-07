# Generating Images with the generate_image Tool

Create AI-generated images directly from your pi session using natural language or structured parameters, powered by Google's Gemini API.

## Prerequisites

- A **Google Gemini API key** — get one from [Google AI Studio](https://aistudio.google.com/apikey)
- A Gemini model that supports image generation (e.g., `gemini-2.0-flash-exp` or `gemini-3-pro-image`)

## Quick Example

Set the required environment variables, then ask pi to generate an image:

```bash
export GEMINI_API_KEY="AIzaSy..."
export PI_IMAGE_MODEL="gemini-3-pro-image"
```

Then in your pi session:

```
Generate an image of a golden retriever playing fetch on a beach at sunset
```

Pi calls the `generate_image` tool, saves the resulting image to `/tmp/pi-work/<project>/`, and returns the file path.

## Setup

Both environment variables are required — without them, `generate_image` returns an error.

| Variable | Description |
|----------|-------------|
| `PI_IMAGE_MODEL` | Gemini model name (e.g., `gemini-3-pro-image`). No default — must be set explicitly. |
| `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Your Google Gemini API key. Either variable name works. |

**For Docker containers**, add both to your `.env` file:

```env
GEMINI_API_KEY=AIzaSy...
PI_IMAGE_MODEL=gemini-3-pro-image
```

Then pass the file with `--env-file /path/to/.env` in your `docker run` command. See [Running Pi in a Docker Container](docker-deployment.html) for the full container setup.

> **Note:** Changes to environment variables require restarting your pi session to take effect.

## Using the Tool

You can ask for images conversationally — pi translates your request into structured parameters automatically. You can also specify parameters explicitly for more control.

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `subject` | **Yes** | Main subject of the image |
| `action` | No | What the subject is doing |
| `scene` | No | Location or environment |
| `composition` | No | Camera angle and framing |
| `lighting` | No | Lighting setup |
| `style` | No | Artistic style (e.g., photorealistic, watercolor, pixel art) |
| `text` | No | Text to render inside the image |
| `aspect_ratio` | No | Image dimensions ratio (defaults to model default) |

### Supported Aspect Ratios

| Ratio | Use Case |
|-------|----------|
| `1:1` | Square — social media avatars, icons |
| `3:4` | Portrait — mobile wallpapers |
| `4:3` | Landscape — presentations |
| `9:16` | Tall portrait — phone screens, stories |
| `16:9` | Widescreen — desktop wallpapers, banners |

## Example Prompts

Here are different ways to ask pi for images, demonstrating the range of styles and parameters:

**Simple request:**
```
Generate an image of a mountain landscape
```

**With style and lighting:**
```
Generate an image of a cat sitting on a windowsill, watercolor style, warm afternoon lighting
```

**With composition and scene:**
```
Generate an image: subject is a vintage typewriter, scene is a cluttered writer's desk,
composition is close-up overhead shot, lighting is soft lamp light, style is photorealistic
```

**With text overlay:**
```
Generate an image of a coffee mug on a table, text "Good Morning", style is minimalist flat design
```

**Specific aspect ratio for a phone wallpaper:**
```
Generate a 9:16 image of a starry night sky over a forest, style is digital painting
```

**Pixel art style:**
```
Generate a 1:1 image of a knight fighting a dragon, pixel art style
```

## Advanced Usage

### How Images Are Saved

Generated images are saved to `/tmp/pi-work/<project-name>/` with auto-generated filenames. Pi reports the full file path in its response, so you can open, copy, or move the file.

### Automatic HTTP Preview in Containers

When running pi inside a Docker container, you can't open local file paths directly in your browser. Pi detects the container environment automatically and spins up an HTTP server to serve the generated image.

After generating an image in a container, pi returns both the file path and a preview URL:

```
Generated 1 image(s):
  /tmp/pi-work/my-project/pi-image-1717123456-a1b2c3.png
  Preview: http://localhost:38291/pi-image-1717123456-a1b2c3.png
```

Open the preview URL in your browser to view the image.

> **Note:** The preview server requires `--network host` on your container. This is already included in the standard Docker run command. See [Running Pi in a Docker Container](docker-deployment.html) for details.

On native (non-container) installs, no HTTP server is started — you can open the saved file directly.

### Request Timeout

Image generation requests time out after **3 minutes**. Complex prompts with detailed parameters may take longer than simple ones, but should complete well within this limit.

## Troubleshooting

**"Error: PI_IMAGE_MODEL environment variable is not set"**
- Set `PI_IMAGE_MODEL` to a valid Gemini image model name and restart pi.

**"Error: No API key found"**
- Set either `GEMINI_API_KEY` or `GOOGLE_API_KEY` and restart pi.

**"Image generation blocked by safety filter"**
- The prompt triggered Gemini's content safety filters. Rephrase your request to avoid restricted content.

**"No image data returned from Gemini"**
- The model processed the request but didn't produce an image. Try rephrasing or simplifying the prompt. Verify your model name supports image generation.

**Preview URL not working in Docker**
- Ensure your container was started with `--network host` so the preview server is accessible from the host browser.

## Related Pages

- [Configuration and Environment Variables Reference](configuration-reference.html)
- [Running Pi in a Docker Container](docker-deployment.html)
- [Extension Architecture and Lifecycle Hooks](extension-architecture.html)
- [Slash Commands and Extension Commands Reference](commands-reference.html)
- [Installing and Starting Your First Session](quickstart.html)
