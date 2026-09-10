// The DeepRecall mark as an inline SVG drawn in currentColor, so the theme
// (or any parent class) can restyle it. The header keeps it white for now.
const BrandMark = ({ className }: { className?: string }) => (
  <svg viewBox="80 80 352 352" className={className} aria-hidden="true">
    <g transform="translate(512 0) scale(-1 1)">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="32"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M 106 256 A 150 150 0 1 0 256 106 A 162.5 162.5 0 0 0 143.7 151.7 L 106 189.3" />
        <path d="M 106 106 L 106 189.3 L 189.3 189.3" />
      </g>
    </g>
    <g fill="currentColor">
      <rect x="156" y="236" width="20" height="40" rx="10" opacity="0.55" />
      <rect x="186" y="224" width="20" height="64" rx="10" opacity="0.7" />
      <rect x="216" y="204" width="20" height="104" rx="10" opacity="0.85" />
      <rect x="246" y="182" width="20" height="148" rx="10" />
      <rect x="276" y="204" width="20" height="104" rx="10" opacity="0.85" />
      <rect x="306" y="224" width="20" height="64" rx="10" opacity="0.7" />
      <rect x="336" y="236" width="20" height="40" rx="10" opacity="0.55" />
    </g>
  </svg>
);

export default BrandMark;
