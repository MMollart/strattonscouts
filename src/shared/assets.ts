/** Physical asset statuses (FR07), shared by the API and the admin UI. */
export const ASSET_STATUSES = ['available', 'assigned', 'lost', 'damaged', 'retired'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];
/** Statuses an administrator may set directly; 'assigned' comes only from an assignment. */
export const ASSET_SETTABLE_STATUSES = ['available', 'lost', 'damaged', 'retired'] as const;
/** Lost and retired assets cannot be lent. */
export const ASSET_ASSIGNABLE_STATUSES = ['available', 'damaged'] as const;
