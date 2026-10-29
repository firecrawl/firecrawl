import { NotificationType } from "../../types";

// depending on the notification type, return the appropriate string
export function getNotificationString(
  notificationType: NotificationType,
): string {
  switch (notificationType) {
    case NotificationType.RATE_LIMIT_REACHED:
      return "Rate limit reached";
    case NotificationType.AUTO_RECHARGE_SUCCESS:
      return "Auto-recharge successful";
    case NotificationType.AUTO_RECHARGE_FAILED:
      return "Auto-recharge failed";
    case NotificationType.CONCURRENCY_LIMIT_REACHED:
      return "Concurrency limit reached";
    default:
      return "Unknown notification type";
  }
}
