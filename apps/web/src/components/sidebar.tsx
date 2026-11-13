import type { ReactNode } from "react";

export interface NavItemProps {
  label: string;
  icon?: ReactNode;
  active?: boolean;
  onSelect: () => void;
}

// A single navigation control. A real <button> so keyboard users reach it;
// the active item is marked aria-current="page".
export function NavItem({ label, icon, active = false, onSelect }: NavItemProps) {
  return (
    <button type="button" className="nav-item" aria-current={active ? "page" : undefined} onClick={onSelect}>
      {icon && (
        <span aria-hidden="true" style={{ display: "inline-flex" }}>
          {icon}
        </span>
      )}
      {label}
    </button>
  );
}

export interface SidebarItem {
  key: string;
  label: string;
  icon?: ReactNode;
}

export interface SidebarProps {
  items: SidebarItem[];
  current: string;
  onSelect: (key: string) => void;
  username: string;
  onSignOut: () => void;
}

// Portal navigation rail: brand, the view switcher, and the signed-in user with
// a log-out control. Stateless — the current view and callbacks come in as props.
export function Sidebar({ items, current, onSelect, username, onSignOut }: SidebarProps) {
  const initial = username.trim().charAt(0).toUpperCase() || "?";
  return (
    <nav className="sidebar" aria-label="Main">
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark" aria-hidden="true">
          G
        </span>
        <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.02em" }}>GetHookd</span>
      </div>

      <div className="sidebar-nav">
        {items.map((item) => (
          <NavItem
            key={item.key}
            label={item.label}
            icon={item.icon}
            active={item.key === current}
            onSelect={() => onSelect(item.key)}
          />
        ))}
      </div>

      <div className="sidebar-user">
        <span className="sidebar-avatar" aria-hidden="true">
          {initial}
        </span>
        <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: 14, fontWeight: 500, overflowWrap: "anywhere" }}>{username}</span>
          <span className="stat-note">Signed in</span>
        </span>
        <button type="button" className="icon-btn" aria-label="Log out" onClick={onSignOut}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" x2="9" y1="12" y2="12" />
          </svg>
        </button>
      </div>
    </nav>
  );
}
