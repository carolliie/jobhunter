import { PrismaClient } from "@prisma/client";

let client: PrismaClient | undefined;
export function getPrisma(): PrismaClient {
  return (client ??= new PrismaClient({ log: ["error"] }));
}
