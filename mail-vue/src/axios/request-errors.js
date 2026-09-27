import axios from 'axios';

// Changing selection or leaving a view aborts requests by design.
export function shouldNotifyRequestFailure(error) {
    return !axios.isCancel(error)
        && error?.code !== 'ERR_CANCELED'
        && error?.message !== 'STALE_SESSION_RESPONSE';
}
