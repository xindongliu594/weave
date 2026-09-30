// Intentional fixture defect: ignores quantity.
export function totalCents(orders) {
  return orders.reduce((sum, order) => sum + order.unitPriceCents, 0);
}
