import type { InputHTMLAttributes, ReactNode } from "react";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  trailing?: ReactNode;
}

export function Field({ label, hint, trailing, className, ...rest }: FieldProps) {
  return (
    <div className="field">
      {label && <span className="field__label">{label}</span>}
      <div style={{ display: "flex", gap: 12 }}>
        <input className={["field-input", className].filter(Boolean).join(" ")} {...rest} />
        {trailing}
      </div>
      {hint && <span className="field__hint">{hint}</span>}
    </div>
  );
}
