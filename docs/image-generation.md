# Image Generation

Generate custom images directly through your AI agents using Google's Gemini models to quickly create visual assets or concept art for your projects. This allows your agents to handle both code changes and their accompanying visual assets without leaving the development environment.

## Prerequisites

- An active Gemini API key.
- A supported Gemini image model (e.g., `gemini-2.0-flash-exp`).

## Quick Example

First, configure your API key and model. You can set the model in `pi-config-settings.json` (`"image_model": "gemini-3-pro-image"`) or use environment variables:

```bash
export GEMINI_API_KEY="your-api-key"
export PI_IMAGE_MODEL="gemini-3-pro-image"
```

Next, ask your agent to generate an image during your chat session:

```text
User: Generate a pixel art image of a cat hacking on a mechanical keyboard.
```

The agent will return the local file path where the image was saved, and if you are running in a containerised environment, a local preview URL.

## Step-by-step

1. **Configure your environment:** Ensure your API key is exposed to the tool (via `GEMINI_API_KEY` or `GOOGLE_API_KEY` env vars). You must also set the model to use for generation, either via the `image_model` setting in `pi-config-settings.json` or the `PI_IMAGE_MODEL` environment variable.

2. **Prompt your agent:** Simply ask your agent to generate an image. The agent will automatically structure your request and invoke the generation tool. You only need to describe the main subject, but you can be as descriptive as you like.

3. **Access the output:** The generated image will be downloaded and saved to your project's `.pi/tmp/` directory. The agent will respond with the absolute path to the `.jpg`, `.png`, or `.webp` file.

## Advanced Usage

When you need precise control over the output, you can ask your agent to use specific compositional parameters.

### Structured Generation Parameters

The generation tool accepts the following detailed parameters. You can ask your agent to explicitly follow these in your prompt:

*   **Subject:** The main focus of the image (required).
*   **Action:** What the subject is currently doing.
*   **Scene:** The location or background environment.
*   **Composition:** Camera angles, framing, and perspective (e.g., "close up", "wide angle").
*   **Lighting:** The lighting setup (e.g., "cinematic lighting", "neon glow", "golden hour").
*   **Style:** The artistic style (e.g., "photorealistic", "watercolor", "pixel art", "cyberpunk").
*   **Text:** Specific text you want rendered directly inside the image.

**Example structured prompt:**
```text
User: Generate an image. Subject: A coffee cup. Action: spilling over. Scene: A busy futuristic desk. Lighting: Neon cyberpunk glow. Style: Photorealistic. Text: "ERROR 404". Aspect ratio: 16:9.
```

### Supported Aspect Ratios

You can instruct the agent to use a specific aspect ratio. The supported values are:
*   `1:1` (Square)
*   `3:4` (Portrait)
*   `4:3` (Landscape)
*   `9:16` (Vertical/Mobile)
*   `16:9` (Widescreen)

### Automatic Preview Server

If you are running the project inside a container (like Docker), the file system is isolated from your host machine. To make viewing images frictionless, the tool automatically detects container environments and spins up a temporary background HTTP server.

When this happens, the agent's response will include both the internal file path and a `http://localhost:<port>/<filename>` preview URL that you can click directly in your terminal or editor to open in your host browser.

## Troubleshooting

*   **"Model not configured":** You must specify the model name before starting your session. Set `image_model` in `pi-config-settings.json` or export `PI_IMAGE_MODEL=gemini-3-pro-image` in your shell.
*   **"Image generation blocked by safety filter":** Gemini's safety filters have blocked the prompt. You will need to rephrase your request to remove potentially unsafe, violent, or explicit concepts.
*   **"No API key found":** Make sure you have exported `GEMINI_API_KEY` or `GOOGLE_API_KEY` in the environment where the daemon is running. See [External AI Agents & CLI](external-ai-agents.html) for more about managing external model keys.

## Related Pages

- [Installation & Quickstart](quickstart.html)
- [Configuration & Settings](configuration.html)
