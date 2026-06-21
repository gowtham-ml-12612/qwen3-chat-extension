// Zoho Show theme catalogue — used for intent classification and automated
// presentation creation.
//
// When the user asks to create a presentation, the classifier picks a theme that
// best matches the topic/mood. The recipe system then uses the theme's `matchLabel`
// to select it in the Zoho Show theme picker UI.
//
// Source: Zoho Show's internal theme API (theme_summary.json).

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Theme {
  /** Zoho Show's internal numeric theme ID. */
  id: string;
  /** Exact display name in the theme picker (used for element matching). */
  name: string;
  /** Description of the visual style and mood. */
  description: string;
  /** Keywords/topics this theme suits — used for intent matching. */
  tags: string[];
  /** Broad presentation types this theme works for. */
  suitedFor: PresentationType[];
}

export type PresentationType =
  | "business"
  | "education"
  | "creative"
  | "technology"
  | "science"
  | "marketing"
  | "portfolio"
  | "pitch-deck"
  | "report"
  | "general"
  | "kids"
  | "events"
  | "nature"
  | "lifestyle";

// ── Theme catalogue ───────────────────────────────────────────────────────────

export const THEMES: Theme[] = [
  // ─── Business & Corporate ─────────────────────────────────────────────────
  {
    id: "3500271000285371473",
    name: "Corporate",
    description: "Subtle background and corporate visuals for business presentations.",
    tags: ["corporate", "business", "professional", "formal", "office", "company"],
    suitedFor: ["business", "report", "pitch-deck"],
  },
  {
    id: "3500271000286199635",
    name: "Executive",
    description: "Blue canvas with polygonal design elements, ideal for business presentations.",
    tags: ["executive", "business", "corporate", "blue", "polygon", "professional"],
    suitedFor: ["business", "report", "pitch-deck"],
  },
  {
    id: "3500271000286283096",
    name: "Classic",
    description: "Classy theme with minimal visuals and bold font, ideal for corporate presentations.",
    tags: ["classic", "corporate", "minimal", "professional", "formal", "classy"],
    suitedFor: ["business", "report"],
  },
  {
    id: "3500271000286108547",
    name: "Grids",
    description: "Grid-style theme with executive font, ideal for data-heavy business presentations.",
    tags: ["grid", "data", "business", "executive", "structured", "table", "analytics"],
    suitedFor: ["business", "report"],
  },
  {
    id: "3500271000285363343",
    name: "Wavy",
    description: "Blue background with minimal designs, ideal for business presentations.",
    tags: ["blue", "business", "wave", "minimal", "professional"],
    suitedFor: ["business", "general"],
  },

  // ─── Technology & Science ─────────────────────────────────────────────────
  {
    id: "3500271000286224641",
    name: "Coders",
    description: "Black background with typewriter font, ideal for programming presentations.",
    tags: ["code", "programming", "developer", "tech", "dark", "hacker", "software", "engineering"],
    suitedFor: ["technology"],
  },
  {
    id: "60123000003350053",
    name: "Cybermesh",
    description: "Dark theme with neon green highlights on structured black grid, futuristic and edgy.",
    tags: ["cyber", "neon", "futuristic", "tech", "dark", "grid", "matrix", "hacker", "startup"],
    suitedFor: ["technology", "pitch-deck"],
  },
  {
    id: "3500271000637304755",
    name: "Neon",
    description: "Sleek modern theme with glowing neon accents and dark background.",
    tags: ["neon", "glow", "dark", "futuristic", "modern", "tech", "night", "gaming"],
    suitedFor: ["technology", "creative"],
  },
  {
    id: "3500271000711781545",
    name: "Sapphire",
    description: "Deep blue gradients with diagonal lines creating depth and motion. Professional and tech-forward.",
    tags: ["sapphire", "blue", "gradient", "tech", "professional", "modern", "deep"],
    suitedFor: ["technology", "business", "pitch-deck"],
  },
  {
    id: "8114000000831655",
    name: "Evolutionary",
    description: "Bold colors and backgrounds inspired by modern science for high-impact presentations.",
    tags: ["science", "evolution", "biology", "research", "bold", "academic"],
    suitedFor: ["science", "education"],
  },
  {
    id: "3500271000286094980",
    name: "Mechanics",
    description: "Minimal background with vectors, ideal for science assignments and projects.",
    tags: ["mechanics", "science", "physics", "engineering", "vectors", "academic"],
    suitedFor: ["science", "education"],
  },
  {
    id: "3500271000464430997",
    name: "Honeycomb",
    description: "Black background with hexagonal patterns and contrasting font.",
    tags: ["hexagon", "honeycomb", "dark", "geometric", "tech", "structured"],
    suitedFor: ["technology", "science"],
  },

  // ─── Creative & Artistic ──────────────────────────────────────────────────
  {
    id: "3500271000286515036",
    name: "Blot",
    description: "White background with splashes of blue, suited for artistic presentations.",
    tags: ["ink", "blot", "art", "blue", "splash", "artistic", "abstract"],
    suitedFor: ["creative", "portfolio"],
  },
  {
    id: "3500271000285717823",
    name: "Art",
    description: "Simple white background with playful font, ideal for creative content.",
    tags: ["art", "creative", "playful", "simple", "drawing", "craft"],
    suitedFor: ["creative", "education"],
  },
  {
    id: "3500271000286187507",
    name: "Abstract",
    description: "Hues of blue and black, ideal for fashion, retail, and jewelry presentations.",
    tags: ["abstract", "fashion", "retail", "jewelry", "dark", "blue", "luxury"],
    suitedFor: ["creative", "marketing", "portfolio"],
  },
  {
    id: "3500271000714261086",
    name: "Sage",
    description: "Playful yet sophisticated with earthy olive tones and pastel accents.",
    tags: ["sage", "olive", "earthy", "pastel", "lifestyle", "design", "creative", "storytelling"],
    suitedFor: ["creative", "lifestyle"],
  },
  {
    id: "3500271000652109014",
    name: "Retro",
    description: "Warm nostalgic tones with modern minimalism. Deep red and cream palette.",
    tags: ["retro", "vintage", "warm", "nostalgic", "red", "cream", "classic"],
    suitedFor: ["creative", "lifestyle"],
  },
  {
    id: "3500271000614546556",
    name: "Whimsy",
    description: "Playful design with decorative swirl patterns and paper airplane motif.",
    tags: ["whimsy", "playful", "fun", "swirl", "lighthearted", "creative"],
    suitedFor: ["creative", "kids"],
  },
  {
    id: "8114000000826894",
    name: "Experimental",
    description: "Professional with black and white graphics, minimalist yet artistic.",
    tags: ["experimental", "minimalist", "artistic", "monochrome", "modern", "professional"],
    suitedFor: ["creative", "portfolio"],
  },
  {
    id: "36481000000374005",
    name: "Playgrid",
    description: "Bright and dynamic with structured grid and bold abstract shapes.",
    tags: ["playful", "grid", "colorful", "dynamic", "creative", "energetic", "bold"],
    suitedFor: ["creative", "marketing"],
  },

  // ─── Dark & Elegant ───────────────────────────────────────────────────────
  {
    id: "3500271000285744039",
    name: "Stardust",
    description: "Elegant black background with yellow patterns for a classy presentation.",
    tags: ["dark", "elegant", "black", "gold", "classy", "premium", "luxury"],
    suitedFor: ["business", "pitch-deck"],
  },
  {
    id: "3500271000628931122",
    name: "Stellar",
    description: "Dark theme with elegant purple designs on black, accented by gold stars.",
    tags: ["stellar", "dark", "purple", "gold", "elegant", "sophisticated", "branding"],
    suitedFor: ["creative", "marketing", "pitch-deck"],
  },
  {
    id: "120420000000063003",
    name: "Cosmo",
    description: "Sleek dark theme with purple gradients and star accents. Modern, cosmic edge.",
    tags: ["cosmic", "dark", "purple", "gradient", "startup", "tech", "space", "innovation"],
    suitedFor: ["technology", "pitch-deck"],
  },
  {
    id: "3500271000286108742",
    name: "Edgy",
    description: "Shades of blue with black background to make your presentation stand out.",
    tags: ["edgy", "dark", "blue", "bold", "modern", "standout"],
    suitedFor: ["technology", "creative"],
  },

  // ─── Minimal & Clean ──────────────────────────────────────────────────────
  {
    id: "8114000000832732",
    name: "Whitepaper",
    description: "A fresh canvas for creating your own unique vision. Perfect for any idea.",
    tags: ["blank", "white", "canvas", "minimal", "clean", "simple", "custom"],
    suitedFor: ["general", "report"],
  },
  {
    id: "3500271000286464066",
    name: "Ideation",
    description: "White background with minimal designs for brainstorming and strategy.",
    tags: ["ideation", "brainstorm", "strategy", "minimal", "whiteboard", "planning"],
    suitedFor: ["business", "general"],
  },
  {
    id: "8114000000827439",
    name: "Strokes",
    description: "Rainfall-inspired patterns on lightly textured background. Distinctive elegance.",
    tags: ["strokes", "rain", "texture", "elegant", "subtle", "refined"],
    suitedFor: ["general", "creative"],
  },
  {
    id: "8114000000822480",
    name: "Geometric",
    description: "Diamond-inspired with purple backgrounds and white lettering. Royal elegance.",
    tags: ["geometric", "diamond", "purple", "royal", "elegant", "shapes"],
    suitedFor: ["business", "creative"],
  },
  {
    id: "8114000000822755",
    name: "Breezy",
    description: "Featherlight strokes of color on minimalist background. Energizing.",
    tags: ["breezy", "light", "minimal", "colorful", "energetic", "fresh"],
    suitedFor: ["general", "lifestyle"],
  },

  // ─── Education & Kids ─────────────────────────────────────────────────────
  {
    id: "3500271000286532132",
    name: "Sunny",
    description: "Colorful sunny landscape illustrations for kindergarten and pre-school.",
    tags: ["sunny", "kids", "kindergarten", "preschool", "colorful", "school", "children"],
    suitedFor: ["kids", "education"],
  },
  {
    id: "8114000000831260",
    name: "Doodles",
    description: "Kid-friendly theme with customized doodle margins for sketches.",
    tags: ["doodle", "kids", "sketch", "draw", "school", "fun", "children"],
    suitedFor: ["kids", "education"],
  },
  {
    id: "3500271000285800109",
    name: "Puppets",
    description: "Colorful puppet illustrations for primary and pre-school assignments.",
    tags: ["puppet", "kids", "preschool", "primary", "colorful", "school", "playful"],
    suitedFor: ["kids", "education"],
  },
  {
    id: "3500271000285084330",
    name: "Savings",
    description: "Designed for children to educate about saving money.",
    tags: ["savings", "money", "finance", "kids", "education", "children", "awareness"],
    suitedFor: ["kids", "education"],
  },
  {
    id: "3500271000285071521",
    name: "Notebook",
    description: "Minimal doodles on elegant background, ideal for engaging audiences.",
    tags: ["notebook", "school", "notes", "doodle", "minimal", "education"],
    suitedFor: ["education", "general"],
  },
  {
    id: "3500271000286325541",
    name: "Chalkboard",
    description: "White canvas with blue printed designs for minimalistic presentations.",
    tags: ["chalkboard", "school", "minimal", "blue", "white", "education", "clean"],
    suitedFor: ["education", "general"],
  },
  {
    id: "8114000000827971",
    name: "Brainstorm",
    description: "Hand-drawn theme with light bulbs on white background for creative ideas.",
    tags: ["brainstorm", "ideas", "lightbulb", "creative", "thinking", "innovation", "startup"],
    suitedFor: ["education", "business", "pitch-deck"],
  },
  {
    id: "3500271000285802237",
    name: "Comics",
    description: "Fun and visually attractive 3D comic illustrations.",
    tags: ["comic", "3d", "fun", "cartoon", "illustration", "kids", "playful"],
    suitedFor: ["kids", "creative"],
  },
  {
    id: "3500271000286332122",
    name: "Patterns",
    description: "Rich designs with playful font style for casual presentations.",
    tags: ["pattern", "playful", "casual", "fun", "colorful"],
    suitedFor: ["general", "creative"],
  },

  // ─── Nature & Environment ─────────────────────────────────────────────────
  {
    id: "3500271000284825418",
    name: "Flora",
    description: "Subtle green background with vine designs that accentuate slides.",
    tags: ["flora", "green", "nature", "vine", "plant", "organic", "botanical"],
    suitedFor: ["nature", "lifestyle"],
  },
  {
    id: "3500271000286447932",
    name: "Greenery",
    description: "White background with green design elements for eco-friendly projects.",
    tags: ["green", "eco", "environment", "nature", "sustainability", "organic"],
    suitedFor: ["nature", "education"],
  },
  {
    id: "8114000000817942",
    name: "Elegance",
    description: "Vintage theme with green leaves for natural and environmental presentations.",
    tags: ["elegance", "vintage", "leaves", "nature", "environment", "green", "earth"],
    suitedFor: ["nature", "lifestyle"],
  },
  {
    id: "3500271000286493685",
    name: "Floral",
    description: "Flower-themed slides with grayscale background and yellow designs.",
    tags: ["floral", "flower", "yellow", "grayscale", "nature", "botanical"],
    suitedFor: ["nature", "lifestyle", "events"],
  },
  {
    id: "3500271000286535236",
    name: "Foliage",
    description: "Grey textured background with dried leaves for fall seasonal presentations.",
    tags: ["foliage", "autumn", "fall", "leaves", "seasonal", "texture"],
    suitedFor: ["nature", "events"],
  },
  {
    id: "3500271000285730185",
    name: "Aquatic",
    description: "Deep ocean vectors with fish and ocean waves throughout.",
    tags: ["aquatic", "ocean", "sea", "fish", "water", "marine", "blue"],
    suitedFor: ["nature", "education"],
  },
  {
    id: "3500271000286219752",
    name: "Wildlife",
    description: "Chalkboard fonts and mixed media images to explore wildlife.",
    tags: ["wildlife", "animals", "nature", "safari", "exploration"],
    suitedFor: ["nature", "education"],
  },

  // ─── Space & Astronomy ────────────────────────────────────────────────────
  {
    id: "8114000000832607",
    name: "Celestial",
    description: "Planetary imagery with bold pops of text color to energize presentations.",
    tags: ["celestial", "space", "planets", "astronomy", "universe", "stars"],
    suitedFor: ["science", "education"],
  },
  {
    id: "3500271000286440297",
    name: "Starry",
    description: "Dark blue background with sky elements, suited for school projects.",
    tags: ["starry", "night", "sky", "stars", "dark blue", "space", "school"],
    suitedFor: ["education", "science"],
  },

  // ─── Events & Seasonal ────────────────────────────────────────────────────
  {
    id: "3500271000285376593",
    name: "Halloween",
    description: "Bold backgrounds and quirky fonts, appropriately spooky for Halloween.",
    tags: ["halloween", "spooky", "scary", "october", "holiday", "party", "fun"],
    suitedFor: ["events"],
  },
  {
    id: "3500271000286332067",
    name: "Colorful",
    description: "Splash of colors with basic font, suited for festive and seasonal greetings.",
    tags: ["colorful", "festive", "greeting", "celebration", "holiday", "party"],
    suitedFor: ["events", "general"],
  },
  {
    id: "3500271000286275352",
    name: "Blossom",
    description: "Colorful background with quirky fonts for an elegant presentation style.",
    tags: ["blossom", "spring", "colorful", "elegant", "quirky", "festive"],
    suitedFor: ["events", "lifestyle"],
  },

  // ─── Lifestyle & Personal ─────────────────────────────────────────────────
  {
    id: "3500271000285709192",
    name: "Candy",
    description: "Playful theme with quirky font style for fun presentations.",
    tags: ["candy", "fun", "playful", "quirky", "sweet", "colorful"],
    suitedFor: ["lifestyle", "kids"],
  },
  {
    id: "3500271000285709626",
    name: "Picnic",
    description: "Colorful and vibrant theme for school trips and holiday itineraries.",
    tags: ["picnic", "travel", "trip", "holiday", "vacation", "outdoor", "colorful"],
    suitedFor: ["lifestyle", "education"],
  },
  {
    id: "3500271000285405284",
    name: "Memories",
    description: "Photograph-framed theme with playful font and minimalist background.",
    tags: ["memories", "photo", "frame", "personal", "scrapbook", "nostalgia"],
    suitedFor: ["lifestyle", "events"],
  },
  {
    id: "3500271000353591774",
    name: "Canine",
    description: "Minimal background with subtle design elements for pet lovers.",
    tags: ["pet", "dog", "canine", "animal", "cute"],
    suitedFor: ["lifestyle"],
  },
  {
    id: "3500271000353732559",
    name: "Pet",
    description: "Fun pet theme for school projects or events like adoption drives.",
    tags: ["pet", "animal", "adoption", "cat", "dog", "school", "event"],
    suitedFor: ["lifestyle", "events", "education"],
  },

  // ─── Culture & Special ────────────────────────────────────────────────────
  {
    id: "3500271000285800109",
    name: "Folklore",
    description: "Minimal background with artistic elements for cultural presentations.",
    tags: ["folklore", "culture", "art", "tradition", "heritage", "ethnic"],
    suitedFor: ["creative", "education"],
  },
  {
    id: "8114000000817505",
    name: "Cultural",
    description: "Japanese theme with colorful artifacts and nature imagery for innovation.",
    tags: ["japanese", "culture", "japan", "asia", "traditional", "innovation", "zen"],
    suitedFor: ["creative", "lifestyle"],
  },
  {
    id: "8114000000817378",
    name: "Theatrical",
    description: "Cranberry backdrop with striking fonts for anecdotes and large audiences.",
    tags: ["theatrical", "drama", "stage", "bold", "audience", "red", "performance"],
    suitedFor: ["creative", "events"],
  },

  // ─── Architecture & Design ────────────────────────────────────────────────
  {
    id: "8114000000829259",
    name: "Origami",
    description: "Papercraft theme with abstract orange cover and dark gray background.",
    tags: ["origami", "paper", "craft", "orange", "creative", "folding"],
    suitedFor: ["creative", "education"],
  },
  {
    id: "3500271000285802140",
    name: "Cardboard",
    description: "Brown textured theme with bold font for arts and crafts presentations.",
    tags: ["cardboard", "craft", "brown", "texture", "handmade", "diy"],
    suitedFor: ["creative", "education"],
  },

  // ─── Aviation & Transport ─────────────────────────────────────────────────
  {
    id: "3500271000286331114",
    name: "Aviation",
    description: "Light blue canvas with minimalistic aircraft designs for airline projects.",
    tags: ["aviation", "airplane", "flight", "airline", "sky", "travel", "transport"],
    suitedFor: ["education", "business"],
  },

  // ─── Miscellaneous ────────────────────────────────────────────────────────
  {
    id: "3500271000286327609",
    name: "Eccentric",
    description: "Minimal background with quirky design elements to stand out.",
    tags: ["eccentric", "quirky", "unique", "standout", "creative", "different"],
    suitedFor: ["creative", "general"],
  },
  {
    id: "3500271000286275379",
    name: "Radiant",
    description: "Bright and radiant design elements with bold font style.",
    tags: ["radiant", "bright", "bold", "colorful", "energetic", "vibrant"],
    suitedFor: ["general", "marketing"],
  },
  {
    id: "3500271000286313870",
    name: "Splash",
    description: "Plain background with green abstract design elements for creativity.",
    tags: ["splash", "green", "abstract", "creative", "fresh"],
    suitedFor: ["creative", "general"],
  },
  {
    id: "3500271000353232246",
    name: "Interlinks",
    description: "White background with hues of green and black, bold font style.",
    tags: ["interlinks", "green", "black", "white", "connected", "modern"],
    suitedFor: ["business", "general"],
  },
  {
    id: "3500271000286283980",
    name: "Frames",
    description: "Frames with hues of green, more ideal for personal use.",
    tags: ["frames", "green", "personal", "photo", "scrapbook"],
    suitedFor: ["lifestyle", "general"],
  },
  {
    id: "3500271000286286901",
    name: "Contrast",
    description: "Plain background with contrasting colored design elements.",
    tags: ["contrast", "colorful", "bold", "clean", "simple"],
    suitedFor: ["general"],
  },
  {
    id: "3500271000285376156",
    name: "Vibrance",
    description: "Deep purple background with bold fonts for cool and creative presentations.",
    tags: ["vibrance", "purple", "bold", "creative", "deep", "cool"],
    suitedFor: ["creative", "marketing"],
  },
  {
    id: "8114000000827570",
    name: "Beehive",
    description: "Hexagonal theme with blue-white backgrounds and bright fonts for corporate images.",
    tags: ["beehive", "hexagon", "blue", "corporate", "brand", "structured"],
    suitedFor: ["business", "marketing"],
  },
];

// ── Theme selection ───────────────────────────────────────────────────────────

export interface ThemeMatch {
  theme: Theme;
  score: number;
}

/**
 * Score all themes against a user query and return them ranked best-first.
 * Pure keyword overlap — no model call needed.
 */
export function rankThemes(query: string): ThemeMatch[] {
  const words = tokenize(query);
  if (words.length === 0) return [];

  const scored: ThemeMatch[] = [];

  for (const theme of THEMES) {
    let score = 0;

    for (const tag of theme.tags) {
      if (words.some((w) => tag.includes(w) || w.includes(tag))) score += 3;
    }

    const nameLower = theme.name.toLowerCase();
    const descLower = theme.description.toLowerCase();
    for (const w of words) {
      if (nameLower.includes(w)) score += 2;
      if (descLower.includes(w)) score += 1;
    }

    for (const type of theme.suitedFor) {
      if (words.includes(type)) score += 4;
    }

    if (score > 0) scored.push({ theme, score });
  }

  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Pick the single best theme for a query, or undefined if nothing matches.
 */
export function selectTheme(query: string): Theme | undefined {
  const ranked = rankThemes(query);
  return ranked[0]?.theme;
}

/**
 * Get a theme by its exact id.
 */
export function getThemeById(id: string): Theme | undefined {
  return THEMES.find((t) => t.id === id);
}

/**
 * Get a theme by its exact name (case-insensitive).
 */
export function getThemeByName(name: string): Theme | undefined {
  const lower = name.toLowerCase();
  return THEMES.find((t) => t.name.toLowerCase() === lower);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}
