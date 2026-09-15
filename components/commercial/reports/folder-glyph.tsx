/**
 * Icons for report folders and reports. Server-safe (no hooks), so both the
 * server-rendered rail and the client menus draw the same shapes.
 */

const FOLDER_PATHS: Record<string, string[]> = {
  folder: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
  briefcase: ["M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M9 6V4h6v2", "M3 12h18"],
  dollar: ["M12 2v20", "M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"],
  hardhat: ["M2 18h20", "M4 18v-3a8 8 0 0 1 16 0v3", "M10 7V5h4v2"],
  chart: ["M3 3v18h18", "M7 14l3-3 4 4 5-6"],
  star: ["M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"],
  all: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"],
};

export const FOLDER_ICON_LABEL: Record<string, string> = {
  folder: "Folder",
  briefcase: "Briefcase",
  dollar: "Money",
  hardhat: "Hard hat",
  chart: "Chart",
  star: "Star",
};

export function FolderGlyph({ icon, size = 16, className = "" }: { icon: string; size?: number; className?: string }) {
  return <PathIcon paths={FOLDER_PATHS[icon] ?? FOLDER_PATHS.folder} size={size} className={className} />;
}

export function PathIcon({ paths, size = 18, strokeWidth = 2, className = "" }: { paths: string[]; size?: number; strokeWidth?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
