import * as ToggleGroup from "@radix-ui/react-toggle-group";

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
}

export function Segmented<T extends string>({ value, onChange, options }: SegmentedProps<T>) {
  return (
    <ToggleGroup.Root
      type="single"
      className="segmented"
      value={value}
      // Radix fires onValueChange with "" when re-clicking the active
      // option would deselect it — this control has no "none" state, so
      // that click is a no-op instead of clearing the value.
      onValueChange={(next) => {
        if (next) onChange(next as T);
      }}
    >
      {options.map((opt) => (
        <ToggleGroup.Item key={opt.value} value={opt.value} disabled={opt.disabled} className="segmented__option">
          {opt.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
