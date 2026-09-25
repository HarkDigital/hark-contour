import type { ChapterDef } from '../core/types'

/**
 * The scroll story, in order. `length` is scroll distance in viewport
 * heights; `landing` is where nav jumps land (local progress, on settled
 * copy — keep it clear of the ~6% cut window at each end). Each chapter lives
 * in src/chapters/<id>/ and default-exports a factory returning a Chapter.
 *
 * Contour: a survey of one studio, sheet by sheet — the chart rises into
 * Relief, the Survey visits six sites, the Summits are eleven services, the
 * Soundings are client voices, Pressure is the storm (security), Layers is
 * how a relief model is built (process), and the Benchmark is where you
 * find us. The ids are shared with src/core/srContent.ts and the chrome's
 * business names.
 */
export const CHAPTERS: ChapterDef[] = [
  { id: 'hero', label: 'Relief', length: 2.6, landing: 0, intro: 0.8, load: () => import('./hero/index') },
  { id: 'work', label: 'Survey', length: 3.8, landing: 0.12, intro: 0.06, load: () => import('./work/index') },
  { id: 'services', label: 'Summits', length: 3.8, landing: 0.08, intro: 0.06, load: () => import('./services/index') },
  { id: 'voices', label: 'Soundings', length: 3.0, landing: 0.08, intro: 0.06, load: () => import('./voices/index') },
  { id: 'shield', label: 'Pressure', length: 1.7, landing: 0.45, intro: 0.45, load: () => import('./shield/index') },
  { id: 'process', label: 'Layers', length: 2.2, landing: 0.17, intro: 0.12, load: () => import('./process/index') },
  { id: 'contact', label: 'Benchmark', length: 1.5, landing: 0.3, intro: 0.3, load: () => import('./contact/index') },
]
