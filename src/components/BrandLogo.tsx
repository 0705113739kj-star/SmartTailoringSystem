import React from 'react';

export const BrandLogo: React.FC<{ dark?: boolean; collapsed?: boolean }> = ({
  dark = false,
  collapsed = false,
}) => {
  return (
    <div className="flex items-center gap-3 shrink-0">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-700 text-white shrink-0">
        <svg viewBox="0 0 36 36" className="h-5 w-5" fill="none" aria-hidden="true">
          <path
            d="M10 7L18 19L26 7"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M18 19V29" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="12.5" cy="26.5" r="3" stroke="#99F6E4" strokeWidth="2" />
          <circle cx="23.5" cy="26.5" r="3" stroke="#99F6E4" strokeWidth="2" />
        </svg>
      </div>
      {!collapsed && (
        <span
          className={`font-display text-base font-bold tracking-tight whitespace-nowrap shrink-0 ${
            dark ? 'text-white' : 'text-slate-900'
          }`}
        >
          SmartTailoringSystem
        </span>
      )}
    </div>
  );
};
