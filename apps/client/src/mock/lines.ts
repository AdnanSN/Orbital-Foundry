/**
 * Mock content for the Stage 2 director: task titles and speech-bubble lines. None of it comes
 * from a model. From Stage 4 the bubbles show real status lines from LLM and tool calls.
 * Keep lines short: bubbles wrap at about 22 characters.
 */

export interface RoleLines {
  /** Task title templates; "{x}" is filled from `subjects`. */
  tasks: readonly string[];
  subjects: readonly string[];
  /** Said while working. */
  work: readonly string[];
}

export const ROLE_LINES: Record<string, RoleLines> = {
  scout: {
    tasks: ["Niche scan: {x}", "Keyword pull: {x}", "Competition check: {x}", "Seasonality: {x}"],
    subjects: [
      "winter candles",
      "cozy cabin decor",
      "pet portraits",
      "retro game icons",
      "dark academia",
      "minimal wall art",
      "wedding gifts",
      "sci-fi UI kits",
    ],
    work: [
      "Pulling search volume…",
      "Checking seasonality…",
      "Competition looks thin.",
      "Trend: up 34% this month",
      "Shortlisting 10 niches…",
      "Cross-checking keywords…",
    ],
  },
  wick: {
    tasks: ["Label: {x} candle", "Listing: {x} candle", "Mockup: {x} jar"],
    subjects: [
      "Pine & Ember",
      "Cedar Smoke",
      "Fig Leaf",
      "Winter Orchard",
      "Black Tea",
      "Salted Honey",
    ],
    work: [
      "Drafting label art…",
      "Prompting 6 variants…",
      "Title: 140 chars max…",
      "13 tags, 20 chars each…",
      "Warm palette, low clutter.",
    ],
  },
  gift: {
    tasks: ["Mug: {x}", "Ornament: {x}", "Tote: {x}"],
    subjects: [
      "custom pet portrait",
      "name star map",
      "teacher thank-you",
      "first Christmas",
      "monogram",
      "dog mom",
    ],
    work: [
      "Mockup on a mug…",
      "Personalization fields…",
      "Writing the listing…",
      "Checking print area…",
      "Font test at 2 inches…",
    ],
  },
  frame: {
    tasks: ["Print: {x}", "Poster set: {x}", "Upscale: {x}"],
    subjects: [
      "nebula line art",
      "botanical trio",
      "retro rocket",
      "mountain sunrise",
      "moon phases",
      "abstract waves",
    ],
    work: [
      "Upscaling 4x…",
      "Fitting the print area…",
      "Tagging wall art…",
      "Picking a frame mockup…",
      "300 dpi check…",
    ],
  },
  flash: {
    tasks: ['Thumbnail: "{x}"', 'Variant set: "{x}"'],
    subjects: ["I QUIT MY JOB", "$0 TO $1K", "DON'T BUY THIS", "IT WORKED?!", "7 DAYS IN SPACE"],
    work: [
      "Hook: 5 words max.",
      "Variant B: more contrast",
      "Cutting out the subject…",
      "Readable at 168x94?",
      "Stroke + drop shadow…",
    ],
  },
  forge: {
    tasks: ["Pack: {x}", "Sprite sheet: {x}"],
    subjects: [
      "32 potion icons",
      "16px dungeon tiles",
      "sci-fi UI kit",
      "slime monsters",
      "pixel food set",
      "tiny spaceships",
    ],
    work: [
      "Palette lock: 16 colours",
      "Chroma key pass…",
      "Packing the sprite sheet…",
      "Outline cleanup…",
      "Style check: 32/32",
    ],
  },
  ledger: {
    tasks: ["{x}"],
    subjects: ["Fee reconcile", "Daily KPIs", "Shadow cost report", "Revenue sync", "Budget check"],
    work: [
      "Reconciling fees…",
      "Shadow cost: $0.42 today",
      "KPIs compiled.",
      "Syncing revenue…",
      "Calls used: 412 / 2,000",
    ],
  },
};

export const WARDEN_LINES = {
  plan: [
    "Setting objectives…",
    "Reassigning load…",
    "Reviewing the board…",
    "3 listings due today.",
    "Reading yesterday's KPIs…",
    "Queue looks healthy.",
  ],
  patrol: ["All systems nominal.", "Looking good, team.", "Status check.", "Carry on.", "Hmm."],
  nudge: ["Back to work, {name}.", "{name}, new task for you.", "Idle, {name}? Got a job."],
  reportThanks: ["Good find.", "Noted. Thanks.", "Adding it to the plan."],
};

export const CREW_REPLIES = {
  nudged: ["On it!", "Right away.", "Sorry, boss.", "Back to it."],
  delivered: ["Ready for QA.", "Batch for QA.", "Here you go, Lens."],
  report: ["Report for WARDEN.", "Fresh numbers."],
  coffee: ["Rate limited. Coffee!", "429 again… coffee.", "Backing off. Coffee."],
  coffeeChat: ["Nice beans.", "Ahh.", "Quiet in here.", "One more minute."],
  coffeeDone: ["Back to it.", "Limit's clear.", "Recharged."],
  rework: ["Fixing it now.", "Reworking…"],
};

export const LENS_LINES = {
  idle: ["IP screen: 0 hits", "Policy checks…", "Queue is clear.", "Updating blocklist…"],
  review: [
    "Checking legibility…",
    "IP screen: 0 hits",
    "Contrast OK.",
    "Garbled text? No.",
    "Edges look clean.",
  ],
  pass: ["PASS. Nice work.", "Approved.", "PASS: on brief."],
  fail: [
    "Rework: text too small",
    "Rework: artifacts",
    "Rework: off-brief",
    "Rework: low contrast",
  ],
};

export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? "");
}
