/**
 * image-gen.ts — Image generation tool via Gemini API
 *
 * Generates images from structured parameters using Google's Gemini API.
 * Model and API key are configured via environment variables:
 *   - PI_IMAGE_MODEL: Gemini model name (e.g., "gemini-2.0-flash-exp")
 *   - GEMINI_API_KEY or GOOGLE_API_KEY: API key
 */

import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
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

function getModel(): string | null {
    return process.env.PI_IMAGE_MODEL || null;
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

function getTempDir(cwd: string): string {
    const basename = path.basename(cwd);
    const dir = path.join("/tmp/pi-work", basename);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getHttpdPath(): string {
    // Resolve relative to this extension's location → ../../scripts/httpd.py
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(thisDir, "..", "..", "scripts", "httpd.py");
}

function serveImage(imagePath: string): { url: string } | null {
    // Only serve via HTTP in containers (where user can't access local files)
    if (!process.env.PI_CONTAINER) return null;

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
        const logFile = path.join("/tmp/pi-work", `httpd-${port}.log`);

        // Launch server in background
        const child = spawn("uv", ["run", "python3", httpd, "--port", port, "--dir", dir], {
            detached: true,
            stdio: ["ignore", fs.openSync(logFile, "a"), fs.openSync(logFile, "a")],
        });
        child.unref();

        return { url: `http://localhost:${port}/${filename}` };
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
            "Requires PI_IMAGE_MODEL and GEMINI_API_KEY/GOOGLE_API_KEY environment variables.",
        ].join("\n"),
        promptSnippet: "generate_image: Generate images from structured descriptions via Gemini API",
        parameters: imageGenSchema,

        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const model = getModel();
            if (!model) {
                return {
                    content: [{
                        type: "text" as const,
                        text: "Error: PI_IMAGE_MODEL environment variable is not set. Set it to a Gemini image model (e.g., PI_IMAGE_MODEL=gemini-2.0-flash-exp) and restart pi.",
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
                const buffer = Buffer.from(image.data, "base64");
                fs.writeFileSync(filepath, buffer);
                savedPaths.push(filepath);
            }

            const lines = [
                `Model: ${model}`,
                `Generated ${savedPaths.length} image(s):`,
            ];
            for (const p of savedPaths) {
                const served = serveImage(p);
                if (served) {
                    lines.push(`  ${p}`);
                    lines.push(`  Preview: ${served.url}`);
                } else {
                    lines.push(`  ${p}`);
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
