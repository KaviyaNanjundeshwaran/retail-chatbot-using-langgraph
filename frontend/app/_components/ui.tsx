import type { ComponentProps, ReactNode } from "react";

/** Joins class names, skipping falsy values. Callers only add layout classes; visual variants come from props. */
export const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");

const focus = "outline-none focus-visible:ring-4 focus-visible:ring-accent/25";

const buttonVariants = {
  primary: "bg-accent text-white hover:bg-accent-hover",
  secondary: "bg-fill text-ink hover:bg-line/70",
  ghost: "text-ink hover:bg-ink/5",
  link: "text-accent hover:underline",
  danger: "bg-danger text-white hover:bg-danger/90",
  subtle: "text-ink-2 hover:bg-ink/5 hover:text-ink",
};
const buttonSizes = {
  sm: "px-3.5 py-1.5 text-[13px]",
  md: "px-4 py-2 text-sm",
  lg: "px-5 py-2.5 text-[15px]",
  icon: "size-9 text-base",
  iconSm: "size-8",
  inline: "text-[13px]",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: keyof typeof buttonVariants; size?: keyof typeof buttonSizes }) {
  return (
    <button
      className={cx(
        "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-full font-medium transition-colors disabled:cursor-default disabled:opacity-40",
        focus,
        buttonVariants[variant],
        buttonSizes[size],
        className
      )}
      {...props}
    />
  );
}

/** Apple-style segmented control. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  full,
}: { options: readonly T[]; value: T; onChange: (v: T) => void; label: string; full?: boolean }) {
  return (
    <div role="tablist" aria-label={label} className={cx("rounded-full bg-fill p-1", full ? "flex w-full" : "inline-flex")}>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          role="tab"
          aria-selected={value === o}
          onClick={() => onChange(o)}
          className={cx(
            "flex-1 cursor-pointer rounded-full px-4 py-1.5 text-[13px] font-medium whitespace-nowrap transition-all",
            focus,
            value === o ? "bg-white text-ink shadow-sm" : "text-ink-2 hover:text-ink"
          )}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

const inputVariants = {
  field: "rounded-xl border-line bg-white",
  pill: "rounded-full border-transparent bg-canvas focus:bg-white",
};

export function Input({ variant = "field", className, ...props }: ComponentProps<"input"> & { variant?: keyof typeof inputVariants }) {
  return (
    <input
      className={cx(
        "w-full border px-4 py-2.5 text-[15px] text-ink transition placeholder:text-ink-3 focus:border-accent disabled:text-ink-3",
        focus,
        inputVariants[variant],
        className
      )}
      {...props}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[13px] font-medium text-ink-2">{label}</span>
      {children}
    </label>
  );
}

export function Checkbox({ label, ...props }: ComponentProps<"input"> & { label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink">
      <input type="checkbox" className="size-4 accent-accent" {...props} />
      {label}
    </label>
  );
}

/** White surface. No padding of its own, so callers choose it. */
export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cx("rounded-2xl bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_16px_rgba(0,0,0,0.04)] ring-1 ring-black/5", className)} {...props} />;
}

export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-black/20 p-4 backdrop-blur-sm" onClick={onClose}>
      <Card role="dialog" aria-modal="true" className="max-h-[88vh] w-full max-w-2xl space-y-5 overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        {children}
      </Card>
    </div>
  );
}

/** Frosted top bar shared by the chat and admin screens. */
export function TopBar({ children }: { children: ReactNode }) {
  return <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b border-line/60 bg-white/80 px-4 backdrop-blur-xl md:px-6">{children}</header>;
}

/** Table with cell styling defined once for every table. */
export function Table({ children }: { children: ReactNode }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full border-collapse text-sm text-ink [&_td]:px-4 [&_td]:py-3 [&_td]:align-middle [&_th]:px-4 [&_th]:py-3 [&_th]:text-left [&_th]:text-xs [&_th]:font-medium [&_th]:text-ink-2 [&_thead_tr]:bg-canvas/60 [&_tr]:border-b [&_tr]:border-line/50 [&_tbody_tr:last-child]:border-0">
        {children}
      </table>
    </Card>
  );
}

export function Bubble({ role, error, children }: { role: "user" | "assistant"; error?: boolean; children: ReactNode }) {
  const look = error
    ? "self-start rounded-bl-md bg-danger/5 text-danger ring-1 ring-danger/20"
    : role === "user"
      ? "self-end rounded-br-md bg-accent text-white"
      : "self-start rounded-bl-md bg-canvas text-ink";
  return <div className={cx("max-w-[85%] rounded-[20px] px-4 py-2.5 text-[15px] leading-relaxed [overflow-wrap:anywhere] md:max-w-2xl", look)}>{children}</div>;
}

export const Title = ({ children }: { children: ReactNode }) => <h2 className="text-xl font-semibold tracking-tight text-ink">{children}</h2>;

export const Muted = ({ children }: { children: ReactNode }) => <p className="text-sm text-ink-2">{children}</p>;

export const ErrorText = ({ children }: { children: ReactNode }) => (
  <p role="alert" className="text-sm text-danger">{children}</p>
);
