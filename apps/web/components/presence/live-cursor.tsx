/**
 * A Figma-style remote cursor: an arrow SVG plus a name pill, tinted with the
 * owner's colour. Pure presentational — no Liveblocks imports — so both the
 * map (react-map-gl `<Marker>`) and the DOM overlays (chat/header) can anchor
 * it. The component's own (0,0) is the pointer tip (the SVG's tip sits at the
 * viewBox's top-left), so callers position this element directly at the
 * cursor coordinate with no further offset math.
 */
export function LiveCursor({ color, name }: { color: string; name: string }) {
  return (
    <div className="pointer-events-none relative">
      <svg
        width={24}
        height={36}
        viewBox="0 0 24 36"
        fill="none"
        className="drop-shadow-[0_2px_4px_rgba(0,0,0,0.35)]"
      >
        <path
          d="M5.65376 12.3673H5.46026L5.31717 12.4976L0.5 16.8829L0.5 1.19841L11.7841 12.3673H5.65376Z"
          fill={color}
          stroke="white"
          strokeWidth="1"
        />
      </svg>
      <span
        className="absolute top-4 left-3 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-white shadow-md"
        style={{ backgroundColor: color }}
      >
        {name}
      </span>
    </div>
  )
}
