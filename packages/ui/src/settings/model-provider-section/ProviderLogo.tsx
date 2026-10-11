import type { ProviderConfigObject } from "@zcode/provider";
import { PackageIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import { resolveBuiltinProviderLogoAsset } from "./providerLogoAssets.js";

type ProviderLogoRef = NonNullable<ProviderConfigObject["logo"]>;

export function ProviderLogo({
  logo,
  className,
}: {
  logo?: ProviderLogoRef | null;
  className?: string;
}) {
  const theme = useZCodeStoreWithDefault((state) => state.theme, "zai-dark");
  const src = resolveBuiltinProviderLogoAsset(logo, resolveTheme(theme));
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!src || failedSrc === src) {
    return <PackageIcon className={cn("shrink-0", className)} aria-hidden="true" />;
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      className={cn("shrink-0 object-contain", className)}
      onError={() => setFailedSrc(src)}
    />
  );
}
