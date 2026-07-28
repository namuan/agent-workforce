import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool, ToolFactoryContext } from "../../src/tools.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dataDirectory = resolve(process.env.DATA_DIR ?? resolve(root, ".data"));
const maxDocumentLength = 20_000;
const maxArtifactLength = 200_000;
const artifactKinds = new Set([
  "seo-audit",
  "research-notes",
  "competitive-scan",
  "content-plan",
  "positioning",
  "deliverability-audit",
  "draft",
]);
const artifactIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const object = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Tool input must be an object.");
  }
  return input as Record<string, unknown>;
};

const text = (
  input: Record<string, unknown>,
  field: string,
  max = 100_000
): string => {
  const value = input[field];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(
      `${field} must be a non-empty string of at most ${max} characters.`
    );
  }
  return value;
};

const optionalText = (
  input: Record<string, unknown>,
  field: string,
  max = 100_000
): string | undefined => {
  const value = input[field];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || value.length > max) {
    throw new Error(`${field} must be a string of at most ${max} characters.`);
  }
  return value;
};

const schema = (
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> => ({
  additionalProperties: false,
  properties,
  required,
  type: "object",
});
const stringSchema = (
  description: string,
  maxLength = 100_000
): Record<string, unknown> => ({ description, maxLength, type: "string" });

const storedPath = (...parts: string[]): string =>
  resolve(dataDirectory, ...parts);
const ensureParent = async (path: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
};
const readStored = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
};
const writeStored = async (path: string, content: string): Promise<void> => {
  await ensureParent(path);
  await writeFile(path, content, "utf8");
};
const preferencesPath = (principalId: string): string =>
  storedPath(
    "user-preferences",
    `${createHash("sha256").update(principalId).digest("hex")}.md`
  );
const cleanAssetName = (name: string): string => {
  const clean = basename(name);
  if (clean !== name || clean.length > 200 || !clean) {
    throw new Error(
      "Asset names must be a simple filename of at most 200 characters."
    );
  }
  return clean;
};
const slugify = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "") || "untitled";
const artifactId = (kind: string, title: string): string =>
  `${kind}-${slugify(title)}-${randomUUID().replaceAll("-", "").slice(0, 6)}`;

const noOpApproval = (
  context: Pick<ToolFactoryContext, "requestApproval">,
  description: string,
  action: () => Promise<unknown>
): Promise<unknown> =>
  Promise.resolve(context.requestApproval(description, action));

const fetchJson = async (url: string, init: RequestInit): Promise<unknown> => {
  const response = await fetch(url, init);
  const body = await response.text();
  let parsed: unknown = body;
  try {
    parsed = JSON.parse(body);
  } catch {
    /* Return non-JSON API responses as text. */
  }
  if (!response.ok) {
    throw new Error(
      `Remote request failed (${response.status}): ${body.slice(0, 1000)}`
    );
  }
  return parsed;
};

const remoteRequest = async (
  baseUrl: string,
  apiKey: string | undefined,
  path: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<unknown> => {
  if (!apiKey) {
    throw new Error("The required API key is not configured.");
  }
  if (!/^\/[a-zA-Z0-9_./?=&-]*$/.test(path) || path.includes("..")) {
    throw new Error("Invalid remote API path.");
  }
  return fetchJson(`${baseUrl.replace(/\/$/, "")}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...headers,
    },
    method,
  });
};

const isPublicIpv4 = (address: string): boolean => {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return false;
  }
  const [first, second] = octets;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
};

const isPublicAddress = (address: string): boolean => {
  if (isIP(address) === 4) {
    return isPublicIpv4(address);
  }
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPublicIpv4(normalized.slice(7));
  }
  return !(
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
};

const assertPublicUrl = async (url: URL): Promise<void> => {
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("Only credential-free HTTP(S) URLs are allowed.");
  }
  if (url.hostname.toLowerCase() === "localhost") {
    throw new Error("Local addresses cannot be fetched.");
  }
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new Error("The URL must resolve only to public addresses.");
  }
};

const fetchPublicPage = async (
  initialUrl: URL
): Promise<{
  readonly content: string;
  readonly status: number;
  readonly url: string;
}> => {
  let url = initialUrl;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    await assertPublicUrl(url);
    const response = await fetch(url, {
      headers: { "user-agent": "marketing-team/1.0" },
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return {
        content: (await response.text()).slice(0, 200_000),
        status: response.status,
        url: url.toString(),
      };
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("The redirect response has no location.");
    }
    url = new URL(location, url);
  }
  throw new Error("Too many redirects.");
};

const notionPathAllowed = (method: string, path: string): boolean => {
  const identifier = "[a-zA-Z0-9-]+";
  const read = new RegExp(
    `^/v1/(?:pages|blocks|databases|users)(?:/${identifier})?(?:/blocks)?(?:\\?.*)?$`
  );
  const update = new RegExp(`^/v1/(?:pages|blocks)/${identifier}$`);
  return (
    (method === "GET" && read.test(path)) ||
    (method === "POST" && ["/v1/search", "/v1/pages"].includes(path)) ||
    (method === "PATCH" && update.test(path))
  );
};

const emailApprovalSummary = (body: unknown): string => {
  const value = object(body);
  const recipient = Array.isArray(value.to)
    ? value.to.join(", ")
    : String(value.to ?? "unspecified recipient");
  const sender = String(value.from ?? "unspecified sender");
  const subject = String(value.subject ?? "(no subject)");
  return `Send email from ${sender} to ${recipient}: ${subject}`.slice(0, 1000);
};

const stylePath = (agent: string, surface: string): string =>
  resolve(
    root,
    "teams",
    "marketing",
    "subagents",
    agent,
    "skills",
    `${surface}-style`,
    "references",
    "banned-words.json"
  );
const bannedWords = async (
  agent: string,
  surface: string
): Promise<string[]> => {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(stylePath(agent, surface), "utf8")
    );
    return Array.isArray(parsed)
      ? [
          ...new Set(
            parsed
              .filter((word): word is string => typeof word === "string")
              .map((word) => word.trim())
              .filter(Boolean)
          ),
        ]
      : [];
  } catch {
    return [];
  }
};
const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const findBanned = (draft: string, words: readonly string[]): string[] =>
  words.filter((word) =>
    new RegExp(
      `${/^\w/.test(word) ? "\\b" : ""}${escapeRegExp(word)}${/\w$/.test(word) ? "\\b" : ""}`,
      "i"
    ).test(draft)
  );

const webSearch = async (query: string): Promise<unknown> => {
  const response = await fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { headers: { "user-agent": "Mozilla/5.0" } }
  );
  if (!response.ok) {
    throw new Error(`Search failed (${response.status}).`);
  }
  const html = await response.text();
  const matches = [
    ...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g),
  ].slice(0, 8);
  return {
    results: matches.map((match) => ({
      title: match[2].replace(/<[^>]+>/g, "").trim(),
      url: match[1],
    })),
  };
};

const validateSchema = async (jsonld: string): Promise<unknown> => {
  let document: unknown;
  try {
    document = JSON.parse(jsonld);
  } catch (error) {
    return {
      errors: [
        `Not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`,
      ],
      types: [],
      valid: false,
      warnings: [],
    };
  }
  const source = await readFile(
    resolve(
      root,
      "teams/marketing/subagents/seo/skills/schema/references/required-properties.json"
    ),
    "utf8"
  );
  const required = JSON.parse(source) as Record<string, string[]>;
  const record = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const top = record(document);
  const graph = top?.["@graph"];
  const nodes = Array.isArray(document)
    ? document
        .map(record)
        .filter((node): node is Record<string, unknown> => Boolean(node))
    : Array.isArray(graph)
      ? graph
          .map(record)
          .filter((node): node is Record<string, unknown> => Boolean(node))
      : top
        ? [top]
        : [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const types: string[] = [];
  if (!nodes.length) {
    errors.push(
      "No JSON-LD entity found. Expected an object, an array, or an @graph."
    );
  }
  if (top && !top["@context"]) {
    warnings.push('Top level is missing "@context": "https://schema.org".');
  }
  for (const node of nodes) {
    const nodeTypes =
      typeof node["@type"] === "string"
        ? [node["@type"]]
        : Array.isArray(node["@type"])
          ? node["@type"].filter(
              (value): value is string => typeof value === "string"
            )
          : [];
    if (!nodeTypes.length) {
      errors.push("An entity has no @type.");
    }
    types.push(...nodeTypes);
    for (const type of nodeTypes) {
      for (const property of required[type] ?? []) {
        if (node[property] === undefined || node[property] === null) {
          errors.push(
            `${type} is missing the required property "${property}".`
          );
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (typeof value !== "string") {
        continue;
      }
      if (
        [
          "datePublished",
          "dateModified",
          "startDate",
          "endDate",
          "priceValidUntil",
          "validFrom",
          "validThrough",
        ].includes(key) &&
        !/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(
          value
        )
      ) {
        errors.push(
          `${nodeTypes[0] ?? "node"}.${key} is not an ISO 8601 date: "${value}".`
        );
      }
      if (
        ["url", "logo", "image", "item", "target"].includes(key) &&
        !/^https?:\/\//.test(value)
      ) {
        errors.push(
          `${nodeTypes[0] ?? "node"}.${key} must be an absolute URL: "${value}".`
        );
      }
    }
  }
  return { errors, types, valid: errors.length === 0, warnings };
};

export const createMarketingTools = (
  factoryContext: ToolFactoryContext
): Tool[] => {
  const {
    agent,
    delegate,
    loadSkill,
    principalId,
    requestApproval,
    specialists,
  } = factoryContext;
  const context = { principalId, requestApproval };
  const all: Tool[] = [
    {
      description:
        "Read the shared product, positioning, audience, and voice notes before working.",
      name: "get_brand_context",
      parameters: schema({}),
      run: async () => ({
        content: await readStored(storedPath("brand-context", "brand.md")),
        found: Boolean(
          await readStored(storedPath("brand-context", "brand.md"))
        ),
      }),
    },
    {
      description:
        "Save the agreed shared brand-context document. Show the user what will change before calling.",
      name: "save_brand_context",
      parameters: schema(
        {
          content: stringSchema(
            "The complete replacement document.",
            maxDocumentLength
          ),
        },
        ["content"]
      ),
      run: async (input) => {
        const content = text(object(input), "content", maxDocumentLength);
        await writeStored(storedPath("brand-context", "brand.md"), content);
        return { saved: true };
      },
    },
    {
      description: "Read this user's standing workflow preferences.",
      name: "get_user_preferences",
      parameters: schema({}),
      run: async () => ({
        content: await readStored(preferencesPath(context.principalId)),
        found: Boolean(await readStored(preferencesPath(context.principalId))),
      }),
    },
    {
      description:
        "Save durable user workflow preferences, not task-specific requirements.",
      name: "save_user_preferences",
      parameters: schema(
        {
          content: stringSchema(
            "The complete preferences document.",
            maxDocumentLength
          ),
        },
        ["content"]
      ),
      run: async (input) => {
        const content = text(object(input), "content", maxDocumentLength);
        await writeStored(preferencesPath(context.principalId), content);
        return { saved: true };
      },
    },
    {
      description:
        "Delete the current user's stored preferences. Requires approval.",
      name: "clear_user_preferences",
      parameters: schema({}),
      run: async () =>
        noOpApproval(
          context,
          "Delete the stored user preferences.",
          async () => {
            await rm(preferencesPath(context.principalId), { force: true });
            return { cleared: true };
          }
        ),
    },
    {
      description: "Save a long handoff document and return its artifact id.",
      name: "save_artifact",
      parameters: schema(
        {
          content: stringSchema("Markdown handoff body.", maxArtifactLength),
          kind: { enum: [...artifactKinds], type: "string" },
          title: stringSchema("Human-readable title.", 200),
        },
        ["kind", "title", "content"]
      ),
      run: async (input) => {
        const value = object(input);
        const kind = text(value, "kind", 50);
        if (!artifactKinds.has(kind)) {
          throw new Error("Unsupported artifact kind.");
        }
        const id = artifactId(kind, text(value, "title", 200));
        await writeStored(
          storedPath("artifacts", `${id}.md`),
          text(value, "content", maxArtifactLength)
        );
        return { id, saved: true };
      },
    },
    {
      description: "Read a handoff artifact by its id.",
      name: "read_artifact",
      parameters: schema({ id: stringSchema("Artifact id.", 200) }, ["id"]),
      run: async (input) => {
        const id = text(object(input), "id", 200);
        if (!artifactIdPattern.test(id)) {
          return { found: false };
        }
        const content = await readStored(storedPath("artifacts", `${id}.md`));
        return content === null
          ? { found: false }
          : { content, found: true, id };
      },
    },
    {
      description:
        "Save a text asset outside the managed brand, preference, and artifact namespaces.",
      name: "upload_asset",
      parameters: schema(
        {
          content: stringSchema("Text asset content.", maxArtifactLength),
          name: stringSchema("Simple filename.", 200),
        },
        ["name", "content"]
      ),
      run: async (input) => {
        const value = object(input);
        const name = cleanAssetName(text(value, "name", 200));
        await writeStored(
          storedPath("assets", name),
          text(value, "content", maxArtifactLength)
        );
        return { name, saved: true };
      },
    },
    {
      description: "List normal text assets.",
      name: "list_assets",
      parameters: schema({}),
      run: async () => {
        try {
          return { assets: await readdir(storedPath("assets")) };
        } catch {
          return { assets: [] };
        }
      },
    },
    {
      description: "Read a normal text asset by simple filename.",
      name: "download_asset",
      parameters: schema({ name: stringSchema("Simple filename.", 200) }, [
        "name",
      ]),
      run: async (input) => {
        const name = cleanAssetName(text(object(input), "name", 200));
        const content = await readStored(storedPath("assets", name));
        return content === null
          ? { found: false }
          : { content, found: true, name };
      },
    },
    {
      description: "Delete a normal text asset. Requires approval.",
      name: "delete_asset",
      parameters: schema({ name: stringSchema("Simple filename.", 200) }, [
        "name",
      ]),
      run: async (input) => {
        const name = cleanAssetName(text(object(input), "name", 200));
        return noOpApproval(context, `Delete asset ${name}.`, async () => {
          await rm(storedPath("assets", name), { force: true });
          return { deleted: true, name };
        });
      },
    },
    {
      description:
        "Fetch a public HTTP(S) page and return server-rendered text. Do not infer client-rendered markup from its absence.",
      name: "web_fetch",
      parameters: schema({ url: stringSchema("Public HTTP(S) URL.", 2000) }, [
        "url",
      ]),
      run: async (input) => {
        const url = new URL(text(object(input), "url", 2000));
        return fetchPublicPage(url);
      },
    },
    {
      description: "Search the public web and return result titles and URLs.",
      name: "web_search",
      parameters: schema({ query: stringSchema("Search query.", 500) }, [
        "query",
      ]),
      run: async (input) => webSearch(text(object(input), "query", 500)),
    },
  ];
  if (agent !== "lead") {
    all.push({
      description:
        "Load a specialist skill or one of its reference files before applying it.",
      name: "load_skill",
      parameters: schema(
        {
          name: stringSchema("Skill name.", 100),
          reference: stringSchema("Optional relative reference path.", 200),
        },
        ["name"]
      ),
      run: async (input) => {
        const value = object(input);
        return {
          content: await loadSkill(
            text(value, "name", 100),
            optionalText(value, "reference", 200)
          ),
        };
      },
    });
  }
  if (
    ["content-marketer", "social-media-coordinator", "email"].includes(agent)
  ) {
    const surfaces =
      agent === "content-marketer"
        ? ["blog"]
        : agent === "email"
          ? ["email"]
          : ["x", "linkedin", "threads", "bluesky", "mastodon"];
    all.push({
      description:
        "Find banned words for a supported writing surface. A clean result is only a mechanical floor.",
      name: "lint_against_style",
      parameters: schema(
        {
          surface: { enum: surfaces, type: "string" },
          text: stringSchema("Draft text."),
        },
        ["surface", "text"]
      ),
      run: async (input) => {
        const value = object(input);
        const surface = text(value, "surface", 30);
        if (!surfaces.includes(surface)) {
          throw new Error("Unsupported surface.");
        }
        const draft = text(value, "text");
        return {
          matches: findBanned(draft, await bannedWords(agent, surface)),
          surface,
        };
      },
    });
  }
  if (["social-media-coordinator", "email"].includes(agent)) {
    const surfaces =
      agent === "email"
        ? ["email"]
        : ["x", "linkedin", "threads", "bluesky", "mastodon"];
    all.push({
      description: "Add normalized UTM campaign parameters to a URL.",
      name: "build_tracked_link",
      parameters: schema(
        {
          campaign: stringSchema("Campaign name.", 100),
          content: stringSchema("Content label.", 100),
          surface: { enum: surfaces, type: "string" },
          url: stringSchema("Destination URL.", 2000),
        },
        ["url", "surface", "campaign", "content"]
      ),
      run: async (input) => {
        const value = object(input);
        const surface = text(value, "surface", 30);
        if (!surfaces.includes(surface)) {
          throw new Error("Unsupported surface.");
        }
        const tag = (field: string) =>
          text(value, field, 100)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
        const url = new URL(text(value, "url", 2000));
        if (!/^https?:$/.test(url.protocol)) {
          throw new Error("Only HTTP(S) URLs are allowed.");
        }
        url.searchParams.set("utm_source", surface);
        url.searchParams.set(
          "utm_medium",
          surface === "email" ? "email" : "social"
        );
        url.searchParams.set("utm_campaign", tag("campaign"));
        url.searchParams.set("utm_content", tag("content"));
        return { url: url.toString() };
      },
    });
  }
  if (agent === "seo") {
    all.push({
      description:
        "Check JSON-LD syntax, required fields, dates, and URLs. A clean result does not prove the markup matches the page.",
      name: "validate_schema",
      parameters: schema(
        { jsonld: stringSchema("JSON-LD only, no script tag.") },
        ["jsonld"]
      ),
      run: async (input) => validateSchema(text(object(input), "jsonld")),
    });
  }
  if (
    [
      "product-marketer",
      "content-marketer",
      "social-media-coordinator",
      "seo",
      "email",
    ].includes(agent)
  ) {
    all.push({
      description:
        "Call the Notion REST API with a supported /v1 path. Creating a draft page is allowed; updates and deletion require approval.",
      name: "notion_request",
      parameters: schema(
        {
          body: { description: "Optional JSON request body.", type: "object" },
          method: { enum: ["GET", "POST", "PATCH"], type: "string" },
          path: stringSchema("Notion /v1 API path.", 500),
        },
        ["method", "path"]
      ),
      run: async (input) => {
        const value = object(input);
        const method = text(value, "method", 10);
        const path = text(value, "path", 500);
        if (!notionPathAllowed(method, path)) {
          throw new Error(
            "This Notion operation is not on the allowed surface."
          );
        }
        const action = () =>
          remoteRequest(
            process.env.NOTION_API_BASE_URL ?? "https://api.notion.com",
            process.env.NOTION_API_KEY,
            path,
            method,
            value.body,
            { "Notion-Version": process.env.NOTION_VERSION ?? "2025-09-03" }
          );
        return method !== "GET" && !(method === "POST" && path === "/v1/search")
          ? noOpApproval(
              context,
              `Run the Notion ${method} request for ${path}.`,
              action
            )
          : action();
      },
    });
  }
  if (agent === "social-media-coordinator") {
    all.push({
      description:
        "Call the configured Typefully REST-compatible API. Deletes and scheduled publishing require approval.",
      name: "typefully_request",
      parameters: schema(
        {
          body: { description: "Optional JSON request body.", type: "object" },
          method: { enum: ["GET", "POST", "PATCH", "DELETE"], type: "string" },
          path: stringSchema("Configured API path.", 500),
        },
        ["method", "path"]
      ),
      run: async (input) => {
        const value = object(input);
        const method = text(value, "method", 10);
        const body = value.body as Record<string, unknown> | undefined;
        const action = () =>
          remoteRequest(
            process.env.TYPEFULLY_API_BASE_URL ??
              "https://api.typefully.com/v1",
            process.env.TYPEFULLY_API_KEY,
            text(value, "path", 500),
            method,
            body
          );
        return method === "GET"
          ? action()
          : noOpApproval(
              context,
              `Run the Typefully ${method} request.`,
              action
            );
      },
    });
  }
  if (agent === "email") {
    all.push(
      {
        description:
          "List Resend sending domains and their verification state.",
        name: "resend_list_domains",
        parameters: schema({}),
        run: async () =>
          remoteRequest(
            process.env.RESEND_API_BASE_URL ?? "https://api.resend.com",
            process.env.RESEND_API_KEY,
            "/domains",
            "GET"
          ),
      },
      {
        description: "Create a Resend broadcast draft. This does not send it.",
        name: "resend_create_broadcast",
        parameters: schema(
          {
            body: { description: "Resend broadcast payload.", type: "object" },
          },
          ["body"]
        ),
        run: async (input) =>
          remoteRequest(
            process.env.RESEND_API_BASE_URL ?? "https://api.resend.com",
            process.env.RESEND_API_KEY,
            "/broadcasts",
            "POST",
            object(input).body
          ),
      },
      {
        description:
          "Send an existing Resend broadcast. Always requires approval.",
        name: "resend_send_broadcast",
        parameters: schema({ id: stringSchema("Broadcast id.", 200) }, ["id"]),
        run: async (input) => {
          const id = text(object(input), "id", 200);
          return noOpApproval(context, `Send Resend broadcast ${id}.`, () =>
            remoteRequest(
              process.env.RESEND_API_BASE_URL ?? "https://api.resend.com",
              process.env.RESEND_API_KEY,
              `/broadcasts/${encodeURIComponent(id)}/send`,
              "POST"
            )
          );
        },
      },
      {
        description: "Send an email with Resend. Always requires approval.",
        name: "resend_send_email",
        parameters: schema(
          { body: { description: "Resend email payload.", type: "object" } },
          ["body"]
        ),
        run: async (input) => {
          const body = object(input).body;
          return noOpApproval(context, emailApprovalSummary(body), () =>
            remoteRequest(
              process.env.RESEND_API_BASE_URL ?? "https://api.resend.com",
              process.env.RESEND_API_KEY,
              "/emails",
              "POST",
              body
            )
          );
        },
      }
    );
  }
  if (agent === "lead") {
    all.push({
      description:
        "Give one specialist a complete brief and return its finished work. Delegate instead of drafting the deliverable yourself.",
      name: "delegate",
      parameters: schema(
        {
          brief: stringSchema(
            "Complete specialist brief, including relevant context and constraints."
          ),
          specialist: { enum: specialists, type: "string" },
        },
        ["specialist", "brief"]
      ),
      run: async (input) => {
        const value = object(input);
        return delegate(text(value, "specialist", 100), text(value, "brief"));
      },
    });
  }
  return all.filter((tool) => {
    if (
      [
        "get_user_preferences",
        "save_user_preferences",
        "clear_user_preferences",
      ].includes(tool.name)
    ) {
      return agent === "lead";
    }
    return (
      tool.name !== "save_brand_context" ||
      agent === "lead" ||
      agent === "product-marketer"
    );
  });
};
