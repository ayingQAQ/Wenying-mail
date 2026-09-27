import { watch } from 'vue';

export function watchMessageSelection(emailId,format,load) {
  // Watch the two scalar sources, not a newly allocated array on every metadata update.
  return watch([emailId,format],load,{immediate:true});
}
