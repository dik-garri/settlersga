import type { AiLevel, Category, MessageKind, ResourceGroup, StartLevel } from '../sim/config';
import type { BuildingType, Resource, SettlerKind } from '../sim/types';
import { lower, t, type Key } from './i18n';

/**
 * Display names of the simulation's ids, from the dictionaries (`src/i18n`): the simulation keeps
 * ids only. The template-literal keys are checked by the compiler against `ru.ts`, so a new building,
 * profession or good without a name there fails the typecheck.
 */
export const buildingName = (type: BuildingType): string => t(`building.${type}`);
export const profName = (kind: SettlerKind): string => t(`prof.${kind}`);
export const resName = (res: Resource): string => t(`res.${res}`);
/** A good's name inside a sentence (lower-case except in German). */
export const resLower = (res: Resource): string => lower(resName(res));
export const categoryName = (c: Category): string => t(`category.${c}`);
export const groupName = (g: ResourceGroup): string => t(`group.${g}`);
export const startName = (s: StartLevel): string => t(`start.${s}`);
export const aiLevelName = (l: AiLevel): string => t(`ai.${l}`);
export const messageTemplate = (k: MessageKind) => `msg.${k}` as const;

/** What a right click makes a specialist do where his order applies (`SPECIALIST_ORDERS`; the cursor hint). */
const ORDER_LABELS: Partial<Record<SettlerKind, Key>> = {
  geologist: 'order.geologist',
  pioneer: 'order.pioneer',
  thief: 'order.thief',
};
export const orderLabel = (kind: SettlerKind): string => {
  const key = ORDER_LABELS[kind];
  return key ? t(key) : '';
};
