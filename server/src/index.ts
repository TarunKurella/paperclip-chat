import { APP_NAME } from "@paperclip-chat/shared";

export async function bootstrapServer(): Promise<string> {
  return `${APP_NAME} server placeholder`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const message = await bootstrapServer();
  console.log(message);
}
