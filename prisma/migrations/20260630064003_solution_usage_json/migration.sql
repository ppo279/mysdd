/*
  Warnings:

  - You are about to drop the column `token` on the `Solution` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Solution" DROP COLUMN "token",
ADD COLUMN     "usage" JSONB;
