// 内联 SVG 图标，替代 emoji（避免无 emoji 字体环境破图）
const paths = {
  dog: (
    <path d="M4 11.5c0 2.5 2 4.5 4 4.5s4-2 4-4.5V9c-1.5 1-3.5 1-5 0v2.5z M4.5 9l-1.5 1M11.5 9l1.5 1M10 13c0 1.5-1 2.5-2 2.5S6 14.5 6 13" />
  ),
  problem: (
    <path d="M8 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2h-2M8 3a2 2 0 002 2h4a2 2 0 002-2M8 7v6M12 7v4M16 7v2" />
  ),
  judge: (
    <path d="M9 2l4 2 4-2v4l4 2-4 2v4l-4-2-4 2v-4l-4-2 4-2V2z" />
  ),
  contest: (
    <path d="M12 3a6 6 0 00-6 6v1H4v3h2v-1h4v6H8v2h8v-2h-2v-6h4v1h2v-3h-2V9a6 6 0 00-6-6zM5 21v-2h14v2" />
  ),
  sandbox: (
    <path d="M9 4l-5 8 5 8h6l5-8-5-8H9zM8 12h8M12 8v8" />
  ),
}

export default function Icon({ name, size = 20, style, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      className={className}
      aria-hidden="true"
    >
      {paths[name] || paths.problem}
    </svg>
  )
}
