// @radix-cjs/* 在 vite.config.mts 里别名到各包真实的 CommonJS dist/index.js。
import * as ScrollArea from "@radix-cjs/scroll-area";
import * as Select from "@radix-cjs/select";

import { startProbeApp } from "./app.js";

startProbeApp({ Select, ScrollArea });
