// Pen icons: 24×24, stroke = currentColor, consistent line weight.
const P = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" };

const ICONS = {
  ballpoint: (
    <>
      <path d="M17 3.5a2.1 2.1 0 0 1 3 3L8 18.5l-4 1 1-4Z" />
      <path d="M15 5.5l3 3" />
    </>
  ),
  fineliner: (
    <>
      <path d="M16 4l4 4-9.5 9.5-4-4Z" />
      <path d="M6.5 13.5 4.6 18.2a.6.6 0 0 0 .8.8l4.6-1.9" />
      <path d="M3.5 20.5l1-1" />
    </>
  ),
  fountain: (
    <>
      <path d="M12 21c-2-3-5-6-5-10l5-8 5 8c0 4-3 7-5 10Z" />
      <path d="M12 3v9" />
      <circle cx="12" cy="13" r="1.3" />
    </>
  ),
  calligraphy: (
    <>
      <path d="M14 3l7 7-7.5 3.5L10.5 10.5Z" />
      <path d="M10.5 10.5 4 20" />
      <path d="M4 20l3.5-2.5" strokeWidth="3" />
    </>
  ),
  brush: (
    <>
      <path d="M9.06 11.9 17.13 3.84a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" />
      <path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" />
    </>
  ),
  pencil: (
    <>
      <path d="M21.17 6.81a1 1 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z" />
      <path d="m15 5 4 4" />
    </>
  ),
  marker: (
    <>
      <path d="M15 3l6 6-8 8-6-6Z" />
      <path d="M7 11l-2 6 2 2 6-2" />
      <path d="M3 21h6" strokeWidth="2.6" />
    </>
  ),
  highlighter: (
    <>
      <path d="m9 11-6 6v3h9l3-3" />
      <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
    </>
  ),
};

export function PenIcon({ id, size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...P} aria-hidden="true">
      {ICONS[id] || ICONS.ballpoint}
    </svg>
  );
}
