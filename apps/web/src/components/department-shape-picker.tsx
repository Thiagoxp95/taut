import { Blobatar } from '@blobatar/react'
import type { Department, DepartmentShape } from '@taut/contract'
import { cn } from '@taut/ui/lib/utils'
import { SHAPE_NAMES, SHAPE_TRAITS, departmentShapes, traitOfShape } from '@/lib/agent-avatar'

/**
 * The department's silhouette, picked from the ten blobatar can draw.
 *
 * Every tile is drawn from one seed — the department's slug — so the colour and
 * the eyes hold still across all eleven tiles and only the outline changes,
 * which is the one thing being chosen. The seed is the department's rather than
 * a fixed one so two departments' pickers do not look identical; it is not any
 * real agent's seed, so the preview shows the silhouette faithfully and the
 * colour only incidentally.
 *
 * `undefined` is the first tile, "Auto": the department keeps taking whatever
 * shape is free by age (see `departmentShapes`). It is a real choice rather
 * than an empty state — a company with three departments has no reason to care
 * which three shapes it got, and auto is the option that never fights another
 * department for one.
 */
export function DepartmentShapePicker({
  value,
  seed,
  auto,
  onChange,
  disabled = false
}: {
  value: DepartmentShape | undefined
  /** The blobatar seed to preview with — the department's slug or name. */
  seed: string
  /** The trait auto currently resolves to, so the Auto tile shows it rather than a guess. */
  auto?: number
  onChange: (shape: DepartmentShape | undefined) => void
  disabled?: boolean
}) {
  return (
    <div role="group" aria-label="Department silhouette" className="flex flex-wrap gap-1.5">
      {[undefined, ...SHAPE_NAMES].map((shape) => {
        const selected = shape === value
        const trait = shape === undefined ? auto : traitOfShape(shape)
        return (
          <button
            key={shape ?? 'auto'}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            title={shape === undefined ? 'Auto — the next free silhouette' : shape}
            onClick={() => onChange(shape)}
            className={cn(
              'flex w-14 shrink-0 flex-col items-center gap-1 rounded-md border p-1.5 outline-none transition-colors',
              'hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50',
              selected ? 'border-primary bg-accent' : 'border-transparent'
            )}
          >
            <Blobatar
              alt=""
              name={seed}
              // An auto department with no departments loaded yet has no trait
              // to draw; the seed picks one, which is what it renders anyway.
              traits={trait === undefined ? undefined : { shape: trait }}
              background={false}
              className="block size-8"
            />
            <span
              className={cn(
                'w-full truncate text-center text-[10px] leading-none',
                selected ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              {shape ?? 'Auto'}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * The silhouette this department would wear on auto, for the Auto tile.
 *
 * Computed with the department itself taken out of the running: the answer for
 * a department being created is the same question as for one being switched
 * back to auto — which shape is left over — and neither should see its own
 * current pick offered back to it as the auto result.
 */
export function autoTrait(
  departments: readonly Department[],
  departmentId?: string
): number | undefined {
  const others = departments.filter((department) => department.id !== departmentId)
  const used = new Set(departmentShapes(others).values())
  return SHAPE_TRAITS.find((trait) => !used.has(trait)) ?? SHAPE_TRAITS[0]
}
