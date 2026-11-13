import type { ReactNode, SVGProps } from 'react'

export type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Glyph({ size = 18, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

export function IconHome(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M3.5 10.5 12 3.5l8.5 7" />
      <path d="M5.5 9.5V20h13V9.5" />
      <path d="M10 20v-5h4v5" />
    </Glyph>
  )
}

export function IconLayers(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8 12 3.5Z" />
      <path d="m3.5 12 8.5 4.5 8.5-4.5" />
      <path d="m3.5 16 8.5 4.5 8.5-4.5" />
    </Glyph>
  )
}

export function IconClock(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </Glyph>
  )
}

export function IconUser(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20c.6-3.4 3.8-5.5 7.5-5.5s6.9 2.1 7.5 5.5" />
    </Glyph>
  )
}

export function IconPlus(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 5v14M5 12h14" />
    </Glyph>
  )
}

export function IconRefresh(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 4.5V9H15" />
    </Glyph>
  )
}

export function IconClose(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </Glyph>
  )
}

export function IconSun(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.6 5.6l1.1 1.1M17.3 17.3l1.1 1.1M18.4 5.6l-1.1 1.1M6.7 17.3l-1.1 1.1" />
    </Glyph>
  )
}

export function IconMoon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
    </Glyph>
  )
}

export function IconAuto(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5v17a8.5 8.5 0 0 0 0-17Z" fill="currentColor" stroke="none" opacity=".35" />
    </Glyph>
  )
}

export function IconPut(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 4v9" />
      <path d="m8.5 9.5 3.5 3.5 3.5-3.5" />
      <path d="M5 19.5h14" />
    </Glyph>
  )
}

export function IconStock(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m3.5 16.5 5.5-5.5 4 4 7.5-7.5" />
      <path d="M15.5 7.5h5v5" />
    </Glyph>
  )
}

export function IconCash(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="3.5" y="6.5" width="17" height="11" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
    </Glyph>
  )
}

export function IconChevronRight(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m9 5 7 7-7 7" />
    </Glyph>
  )
}
