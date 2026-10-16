import type { Page } from '@playwright/test'

/** Computed solid-color text checks; gradients, video and native shadow controls
 * still need visual review. Alpha colors are composited against ancestor surfaces. */
export async function textContrast(page: Page) {
  return page.evaluate(() => {
    type Color = [number, number, number, number]
    const parse = (value: string): Color => {
      const channels = value.match(/[\d.]+/g)?.map(Number) ?? []
      // Computed color-mix() backgrounds can serialize as color(srgb ...),
      // whose channels use 0–1 rather than rgb()'s 0–255 values.
      if (value.startsWith('color(srgb ')) {
        return [(channels[0] ?? 0) * 255, (channels[1] ?? 0) * 255, (channels[2] ?? 0) * 255, channels[3] ?? 1]
      }
      return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0, channels[3] ?? 1]
    }
    const over = (front: Color, back: Color): Color => {
      const alpha = front[3] + back[3] * (1 - front[3])
      if (alpha === 0) return [0, 0, 0, 0]
      return [0, 1, 2].map(i => (front[i] * front[3] + back[i] * back[3] * (1 - front[3])) / alpha).concat(alpha) as Color
    }
    const luminance = (color: Color) => color.slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0)
    const background = (element: Element): Color => {
      let current: Element | null = element
      let result: Color = [0, 0, 0, 0]
      while (current && result[3] < 0.999) {
        result = over(result, parse(getComputedStyle(current).backgroundColor))
        current = current.parentElement
      }
      return over(result, [255, 255, 255, 1])
    }
    return [...document.querySelectorAll<HTMLElement>('h1,h2,h3,p,label,button:not([disabled]),a,input:not([disabled]),select:not([disabled]),code,small,.field-hint,.timecode-help')]
      .filter(element => element.getClientRects().length > 0 && !element.closest('dialog:not([open])') && (element.innerText.trim() || element instanceof HTMLInputElement || element instanceof HTMLSelectElement))
      .flatMap(element => {
        const style = getComputedStyle(element)
        const bg = background(element)
        const label = element.innerText.trim().replace(/\s+/g, ' ').slice(0, 80) || element.getAttribute('aria-label') || element.id
        const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && parseInt(style.fontWeight) >= 700)
        const measure = (color: string, suffix = '') => {
          const foreground = over(parse(color), bg)
          const a = luminance(foreground), b = luminance(bg)
          return { label: label + suffix, foreground: color, background: bg, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), minimum: large ? 3 : 4.5 }
        }
        const results = [measure(style.color)]
        if (element instanceof HTMLInputElement && element.placeholder) {
          const placeholder = getComputedStyle(element, '::placeholder')
          const color = parse(placeholder.color)
          color[3] *= parseFloat(placeholder.opacity)
          results.push(measure(`rgba(${color.join(',')})`, ' placeholder'))
        }
        return results
      })
  })
}
