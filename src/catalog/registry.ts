import { loadInstalledPieces } from './activepieces.js';
import { cloudflare } from './native/cloudflare.js';
import { googleAnalytics } from './native/google-analytics.js';
import { stackexchange } from './native/stackexchange.js';
import type { ToolDef, Toolkit } from './types.js';

export const NATIVE_TOOLKITS: Toolkit[] = [stackexchange, cloudflare, googleAnalytics];

export class Registry {
  private readonly toolkits = new Map<string, Toolkit>();
  private readonly tools = new Map<string, ToolDef>();

  constructor(toolkits: Toolkit[]) {
    for (const tk of toolkits) {
      // Native toolkits win over a same-named piece so we can override a weak piece.
      if (this.toolkits.has(tk.slug) && tk.source !== 'native') continue;
      this.toolkits.set(tk.slug, tk);
    }
    for (const tk of this.toolkits.values()) for (const t of tk.tools) this.tools.set(t.slug, t);
  }

  static default(): Registry {
    return new Registry([...NATIVE_TOOLKITS, ...loadInstalledPieces()]);
  }

  listToolkits(): Toolkit[] {
    return [...this.toolkits.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  getToolkit(slug: string): Toolkit | undefined {
    return this.toolkits.get(slug);
  }

  getTool(slug: string): ToolDef | undefined {
    return this.tools.get(slug);
  }

  searchTools(query: string, opts: { toolkits?: string[]; limit?: number } = {}): ToolDef[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored: { t: ToolDef; score: number }[] = [];
    for (const t of this.tools.values()) {
      if (opts.toolkits && !opts.toolkits.includes(t.toolkit)) continue;
      const hay = `${t.slug} ${t.displayName} ${t.description}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (t.displayName.toLowerCase().includes(term)) score += 3;
        else if (hay.includes(term)) score += 1;
        else {
          score = -1;
          break;
        }
      }
      if (score > 0 || (!terms.length && score === 0)) scored.push({ t, score });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.t.slug.localeCompare(b.t.slug))
      .slice(0, opts.limit ?? 20)
      .map((s) => s.t);
  }
}
