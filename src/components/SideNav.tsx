import { SideNavContent } from "./SideNavContent";

interface SideNavProps {
  onNewProject: () => void;
}

/**
 * Desktop sidebar wrapper — hidden on mobile (< md). Mobile uses
 * `MobileNavDrawer` instead, which renders the same `SideNavContent`
 * inside a Sheet.
 */
export function SideNav({ onNewProject }: SideNavProps) {
  return (
    <nav className="hidden w-56 shrink-0 flex-col gap-1 border-r p-3 md:flex">
      <SideNavContent onNewProject={onNewProject} />
    </nav>
  );
}
