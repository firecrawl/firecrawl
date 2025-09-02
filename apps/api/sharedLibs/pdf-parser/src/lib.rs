use std::ffi::{CStr, CString};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PDFMetadata {
    num_pages: i32,

    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

fn _get_pdf_metadata(path: &str) -> Result<PDFMetadata, String> {
    let doc = match lopdf::Document::load(path) {
        Ok(x) => x,
        Err(_) => {
            return Err("Failed to load PDF".to_string());
        }
    };

    let num_pages = doc.get_pages().len() as i32;
    let title = doc.trailer.get(b"Info")
        .and_then(|info| info.as_dict()
            .and_then(|info| info.get(b"Title"))
            .and_then(|title| title.as_str().map(|s| String::from_utf8_lossy(s).to_string()))
        ).ok()
        .or_else(|| doc.objects.iter()
            .find_map(|(_i, obj)| obj.as_dict()
                .and_then(|obj| obj.get(b"Title"))
                .and_then(|title| title.as_str())
                .map(|s| String::from_utf8_lossy(s).to_string())
                .ok()
            )
        )
        .map(|x| x.trim_matches(|x| char::is_whitespace(x) || x == '\0').to_string());
    
    Ok(PDFMetadata { num_pages, title })
}

/// Returns the metadata of a PDF file
/// 
/// # Safety
/// Input path must be a C string of a path pointing to a PDF file. Output will be a JSON string of the PDF metadata.
#[no_mangle]
pub unsafe extern "C" fn get_pdf_metadata(path: *const libc::c_char) -> *const libc::c_char {
    let path: String = match unsafe { CStr::from_ptr(path) }.to_str().map_err(|_| ()) {
        Ok(x) => x.to_string(),
        Err(_) => {
            return CString::new("RUSTFC:ERROR:Failed to parse input path as C string").unwrap().into_raw();
        }
    };

    let metadata = match _get_pdf_metadata(&path) {
        Ok(x) => x,
        Err(e) => {
            return CString::new(format!("RUSTFC:ERROR:Failed to get PDF metadata: {}", e)).unwrap().into_raw();
        }
    };

    let json = match serde_json::to_string(&metadata) {
        Ok(x) => x,
        Err(e) => {
            return CString::new(format!("RUSTFC:ERROR:Serde failed to serialize metadata: {}", e)).unwrap().into_raw();
        }
    };

    CString::new(json).unwrap().into_raw()
}
