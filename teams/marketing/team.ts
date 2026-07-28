import type { TeamModule } from "../../src/team.ts";
import { createMarketingTools } from "./tools.ts";

export default {
  agents: {
    "content-marketer": {
      description:
        "Long-form marketing content including blog posts, landing pages, case studies, newsletters, and documentation. Plans and edits the work, then can save it to Notion.",
    },
    email: {
      description:
        "Adapts existing copy for email, builds Resend campaigns, checks sending-domain evidence, and sends only after explicit approval. Long-form prose should be written first by the content marketer.",
    },
    "product-marketer": {
      description:
        "Positioning, competitive alternatives, ideal customers, message hierarchy, value propositions, objections, and the shared brand context document. Interviews and researches rather than inventing claims.",
    },
    seo: {
      description:
        "Organic search strategy, URL and on-page reviews, site architecture, internal linking, JSON-LD schema, and programmatic SEO. Reports only evidence it can fetch or verify.",
    },
    "social-media-coordinator": {
      description:
        "Posts and threads for X, LinkedIn, Threads, Bluesky, and Mastodon, plus Typefully drafts, scheduling, and analytics.",
    },
  },
  createTools: createMarketingTools,
  id: "marketing",
  leadDelegationGuidance:
    "Load the brand context and user preferences before delegating. Delegate rather than draft the deliverable yourself. A newsletter usually needs content-marketer, then email.",
} satisfies TeamModule;
