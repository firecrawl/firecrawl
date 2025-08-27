use std::{ffi::CStr};

/// Returns the number of pages in a PDF file
/// 
/// # Safety
/// Input path must be a C string of a path pointing to a PDF file. Output will be an integer, either the number of pages in the PDF or -1 indicating an error.
#[no_mangle]
pub unsafe extern "C" fn get_page_count(path: *const libc::c_char) -> i32 {
    let path: String = match unsafe { CStr::from_ptr(path) }.to_str().map_err(|_| ()) {
        Ok(x) => x.to_string(),
        Err(_) => {
            return -1;
        }
    };

    let doc = match lopdf::Document::load(&path) {
        Ok(x) => x,
        Err(_) => {
            return -1;
        }
    };

    doc.get_pages().len() as i32
}