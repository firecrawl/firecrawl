//! Giving memory back.
//!
//! Parsing big pages allocates a lot for a moment. The allocator keeps that
//! memory for reuse, which makes an idle engine look far larger than it is.
//! This asks it to return what it is not using.

/// Return free heap memory to the operating system. Safe to call at any
/// time.
pub fn release_free_memory() {
  unsafe {
    libmimalloc_sys::mi_collect(true);
  }
}
