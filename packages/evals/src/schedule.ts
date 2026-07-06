export function isAllowedHour(date: Date, allowedHours: number[]): boolean {
  if (allowedHours.length === 0) {
    return true;
  }

  return allowedHours.includes(date.getHours());
}

export function assertAllowedHour(date: Date, allowedHours: number[]): void {
  if (!isAllowedHour(date, allowedHours)) {
    throw new Error(`current hour ${date.getHours()} is outside schedule.allowed_hours`);
  }
}
