// 必须尽早加载：让 Main 的日志与文件 I/O 在应用模块初始化前进入内存计数器。
import { startDiskIoTelemetry } from "./diskIoTelemetry.js";

startDiskIoTelemetry();
