import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { CSSProperties } from "react";

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
  style?: CSSProperties;
}

export function Switch({ checked, onChange, disabled, ...rest }: SwitchProps) {
  return (
    <SwitchPrimitive.Root checked={checked} onCheckedChange={onChange} disabled={disabled} className="switch" {...rest}>
      <SwitchPrimitive.Thumb className="switch__thumb" />
    </SwitchPrimitive.Root>
  );
}
