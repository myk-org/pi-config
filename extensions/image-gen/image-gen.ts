/**
 * image-gen.ts — Image generation tool via Gemini API
 *
 * Generates images from structured parameters using Google's Gemini API.
 * Model via pi-config-settings.json (`image_model`) or PI_IMAGE_MODEL env.
 * API key via GEMINI_API_KEY or GOOGLE_API_KEY (env only — secrets stay out of settings).
 */

import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getSetting } from "../orchestrator/project-settings.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ASPECT_RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9"] as const;
const IMAGE_TIMEOUT = 3 * 60 * 1000; // 3 minutes

const imageGenSchema = Type.Object({
    subject: Type.String({ description: "Main subject of the image" }),
    action: Type.Optional(Type.String({ description: "What the subject is doing" })),
    scene: Type.Optional(Type.String({ description: "Location or environment" })),
    composition: Type.Optional(Type.String({ description: "Camera angle and framing" })),
    lighting: Type.Optional(Type.String({ description: "Lighting setup" })),
    style: Type.Optional(Type.String({ description: "Artistic style (e.g., photorealistic, watercolor, pixel art)" })),
    text: Type.Optional(Type.String({ description: "Text to render in the image" })),
    aspect_ratio: Type.Optional(Type.Enum(
        Object.fromEntries(ASPECT_RATIOS.map(r => [r, r])) as Record<string, string>,
        { description: "Aspect ratio: 1:1, 3:4, 4:3, 9:16, 16:9" }
    )),
});

interface GeminiPart {
    text?: string;
    inlineData?: { mimeType: string; data: string };
}

interface GeminiCandidate {
    content?: { parts?: GeminiPart[] };
}

interface GeminiResponse {
    candidates?: GeminiCandidate[];
    promptFeedback?: { blockReason?: string };
}

function getApiKey(): string | null {
    return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null;
}

function getModel(cwd: string): string | null {
    const model = getSetting(cwd, "image_model");
    return model || null;
}

function assemblePrompt(params: {
    subject: string;
    action?: string;
    scene?: string;
    composition?: string;
    lighting?: string;
    style?: string;
    text?: string;
}): string {
    const parts: string[] = [];

    const subjectParts = [params.subject];
    if (params.action) subjectParts.push(params.action);
    if (params.scene) subjectParts.push(params.scene);
    parts.push(subjectParts.join(", "));

    if (params.composition) parts.push(params.composition);
    if (params.lighting) parts.push(params.lighting);
    if (params.style) parts.push(params.style);

    let prompt = `${parts.map(p => p.replace(/[.!,;:]+$/, "")).join(". ")}.`;

    if (params.text) {
        prompt += `\n\nText: ${params.text}`;
    }

    return prompt;
}

function getExtensionForMime(mimeType: string): string {
    const map: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
    };
    return map[mimeType] ?? "png";
}

// Same logic as getProjectTmpDir in extensions/orchestrator/utils.ts
function getTempDir(cwd: string): string {
    const dir = path.join(cwd, ".pi", "tmp");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getHttpdPath(): string {
    // Resolve relative to this extension's location → ../../scripts/httpd.py
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(thisDir, "..", "..", "scripts", "httpd.py");
}

function serveImage(imagePath: string): { url: string; port: string; dir: string } | null {
    // Only serve via HTTP in containers (where user can't access local files)
    // Use filesystem checks matching orchestrator's isRunningInContainer()
    const inContainer = fs.existsSync("/.dockerenv") ||
        fs.existsSync("/run/.containerenv") ||
        (() => { try { return fs.readFileSync("/proc/1/cgroup", "utf-8").includes("docker") || fs.readFileSync("/proc/1/cgroup", "utf-8").includes("containerd"); } catch { return false; } })();
    if (!inContainer) return null;

    const httpd = getHttpdPath();
    if (!fs.existsSync(httpd)) return null;

    try {
        // Find a free port
        const port = execFileSync("uv", ["run", "python3", httpd, "--find-port"], {
            encoding: "utf-8",
            timeout: 5000,
        }).trim();

        const dir = path.dirname(imagePath);
        const filename = path.basename(imagePath);
        const logFile = path.join(dir, `httpd-${port}.log`);

        // Launch server in background — close FDs after spawn
        const logFd = fs.openSync(logFile, "a");
        const child = spawn("uv", ["run", "python3", httpd, "--port", port, "--dir", dir], {
            detached: true,
            stdio: ["ignore", logFd, logFd],
        });
        child.unref();
        fs.closeSync(logFd);

        return { url: `http://localhost:${port}/${filename}`, port, dir };
    } catch {
        return null;
    }
}

export function createImageGenTool(): ToolDefinition {
    return {
        name: "generate_image",
        label: "GenerateImage",
        description: [
            "Generate an image from a structured description using Gemini.",
            "Provide a subject (required) and optional parameters for action, scene, composition, lighting, style, and text.",
            "Returns the file path of the generated image.",
            "Requires image_model in pi-config-settings.json (or PI_IMAGE_MODEL) and GEMINI_API_KEY/GOOGLE_API_KEY.",
        ].join("\n"),
        promptSnippet: "generate_image: Generate images from structured descriptions via Gemini API",
        parameters: imageGenSchema,

        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const model = getModel(ctx.cwd);
            if (!model) {
                return {
                    content: [{
                        type: "text" as const,
                        text: "Error: image model is not set. Add image_model to pi-config-settings.json (or PI_IMAGE_MODEL env) and reload pi.",
                    }],
                };
            }

            const apiKey = getApiKey();
            if (!apiKey) {
                return {
                    content: [{
                        type: "text" as const,
                        text: "Error: No API key found. Set GEMINI_API_KEY or GOOGLE_API_KEY environment variable and restart pi.",
                    }],
                };
            }

            const promptText = assemblePrompt(params);

            const generationConfig: Record<string, unknown> = {
                responseModalities: ["IMAGE"],
            };
            if (params.aspect_ratio) {
                generationConfig.imageConfig = { aspectRatio: params.aspect_ratio };
            }

            const requestBody = {
                contents: [{ role: "user" as const, parts: [{ text: promptText }] }],
                generationConfig,
            };

            const abortSignal = signal ?? AbortSignal.timeout(IMAGE_TIMEOUT);

            let response: Response;
            try {
                response = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "x-goog-api-key": apiKey,
                        },
                        body: JSON.stringify(requestBody),
                        signal: abortSignal,
                    },
                );
            } catch (err: any) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `Error: Gemini API request failed: ${err?.message ?? String(err)}`,
                    }],
                };
            }

            const rawText = await response.text();
            if (!response.ok) {
                let message = rawText;
                try {
                    const parsed = JSON.parse(rawText) as { error?: { message?: string } };
                    message = parsed.error?.message ?? message;
                } catch {
                    // Keep raw text
                }
                return {
                    content: [{
                        type: "text" as const,
                        text: `Error: Gemini image request failed (${response.status}): ${message}`,
                    }],
                };
            }

            let data: GeminiResponse;
            try {
                data = JSON.parse(rawText) as GeminiResponse;
            } catch {
                return {
                    content: [{
                        type: "text" as const,
                        text: `Error: Failed to parse Gemini response: ${rawText.slice(0, 200)}`,
                    }],
                };
            }

            if (data.promptFeedback?.blockReason) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `Error: Image generation blocked by safety filter: ${data.promptFeedback.blockReason}`,
                    }],
                };
            }

            const images: { data: string; mimeType: string }[] = [];
            let responseText = "";

            for (const candidate of data.candidates ?? []) {
                for (const part of candidate.content?.parts ?? []) {
                    if (part.inlineData?.data && part.inlineData?.mimeType) {
                        images.push({
                            data: part.inlineData.data,
                            mimeType: part.inlineData.mimeType,
                        });
                    }
                    if (part.text) {
                        responseText += part.text;
                    }
                }
            }

            if (images.length === 0) {
                const extra = responseText ? `\n\n${responseText}` : "";
                return {
                    content: [{
                        type: "text" as const,
                        text: `No image data returned from Gemini.${extra}`,
                    }],
                };
            }

            const cwd = ctx?.cwd ?? process.cwd();
            const tempDir = getTempDir(cwd);
            const savedPaths: string[] = [];

            for (const image of images) {
                const ext = getExtensionForMime(image.mimeType);
                const filename = `pi-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
                const filepath = path.join(tempDir, filename);
                try {
                    const buffer = Buffer.from(image.data, "base64");
                    if (buffer.length === 0) continue; // Skip empty/malformed data
                    fs.writeFileSync(filepath, buffer);
                    savedPaths.push(filepath);
                } catch (err: any) {
                    // Skip corrupted image data — log but don't crash
                    console.debug(`[image-gen] Failed to decode/save image: ${err?.message?.slice(0, 100)}`);
                }
            }

            // Start a single preview server for all images (container only)
            let previewServer: { url: string; port: string; dir: string } | null = null;
            if (savedPaths.length > 0) {
                previewServer = serveImage(savedPaths[0]);
            }

            const lines = [
                `Model: ${model}`,
                `Generated ${savedPaths.length} image(s):`,
            ];
            for (const p of savedPaths) {
                lines.push(`  ${p}`);
                if (previewServer) {
                    const filename = path.basename(p);
                    lines.push(`  Preview: http://localhost:${previewServer.port}/${filename}`);
                }
            }
            if (responseText.trim()) {
                lines.push("", responseText.trim());
            }

            return {
                content: [{
                    type: "text" as const,
                    text: lines.join("\n"),
                }],
            };
        },
    };
}
