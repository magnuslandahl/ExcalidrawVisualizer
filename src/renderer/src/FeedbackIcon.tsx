const paths = {
  close: 'M6 6l12 12M18 6 6 18',
  microphone: 'M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0ZM5 10v1a7 7 0 0 0 14 0v-1M12 18v4M8 22h8',
  write: 'm4 16 12-12 4 4L8 20H4Zm10-10 4 4',
  clear: 'm4 13 9-9 7 7-9 9H7l-3-3Zm5-5 7 7M11 20h10',
  copy: 'M9 8h11v13H9ZM15 8V3H4v13h5',
  queue: 'M4 5h16M4 10h16M4 15h6M4 20h6M17 14v7M13.5 17.5h7',
  send: 'm3 3 18 9-18 9 4-9Zm4 9h14',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  pair: 'm9 15 6-6M8 12l-3 3a3 3 0 0 0 4 4l3-3M12 8l3-3a3 3 0 0 1 4 4l-3 3',
  unpair: 'm3 3 18 18M7 13l-2 2a3 3 0 0 0 4 4l2-2M13 7l2-2a3 3 0 0 1 4 4l-2 2',
  refresh: 'M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m-5 0h5v5',
  transcribe: 'M14 3H5v18h14V8Zm0 0v5h5M8 12h8M8 16h8',
  retire: 'M3 3h18v5H3ZM5 8v13h14V8M9 12h6'
}

export function FeedbackIcon({ name }: { name: keyof typeof paths }): React.JSX.Element {
  return (
    <svg
      className="feedback-button-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  )
}
