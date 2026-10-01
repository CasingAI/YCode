import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { SubmissionMode } from "@zcode/shared/zcode-protocol-v4";

export const INHERIT_MODE_VALUE = "__inherit__";
export const COMMAND_MODE_OPTIONS: readonly SubmissionMode[] = ["yolo", "plan", "readonly"];

function CommandModeFieldLabel({ children }: { children: string }) {
  return (
    <label className="mb-1 block text-ui-base font-medium text-foreground-subtle">{children}</label>
  );
}

export function CommandModeField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="space-y-1.5">
      <CommandModeFieldLabel>
        {intl.formatMessage({ id: "settings.commands.form.mode.label" })}
      </CommandModeFieldLabel>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger size="lg" className="w-full md:w-48">
          <SelectValue
            placeholder={intl.formatMessage({ id: "settings.commands.form.mode.inherit" })}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={INHERIT_MODE_VALUE}>
            {intl.formatMessage({ id: "settings.commands.form.mode.inherit" })}
          </SelectItem>
          {COMMAND_MODE_OPTIONS.map((mode) => (
            <SelectItem key={mode} value={mode}>
              {intl.formatMessage({ id: `mode.label.glm.${mode}` })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.commands.form.mode.hint" })}
      </p>
    </div>
  );
}
