#![allow(non_snake_case)]

use std::ffi::CStr;
use std::os::raw::{c_char, c_void};
use std::ptr;

cfg_if::cfg_if! {
    if #[cfg(unix)] {
        use libc::{open, close, lseek, mmap, munmap, PROT_READ, MAP_PRIVATE, SEEK_END};
    } else if #[cfg(windows)] {
        use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE, CloseHandle};
        use windows_sys::Win32::System::Memory::{
            CreateFileMappingA, MapViewOfFile, UnmapViewOfFile,
            FILE_MAP_READ, PAGE_READONLY, MEMORY_MAPPED_VIEW_ADDRESS
        };
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileA, GetFileSizeEx, OPEN_EXISTING, FILE_SHARE_READ,
            FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, OPEN_ALWAYS
        };

    }
}

/// Opens a file and maps it into memory for read-only access.
/// Returns a pointer to the mapped memory, or null on failure.
/// The file length is written to `len_out`.
///
/// Safety: The returned pointer is valid until `mmap_close` is called.
/// Do not access it after closing.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mmap_open(path: *const c_char, len_out: *mut usize) -> *mut c_void {
    unsafe {
        if path.is_null() || len_out.is_null() {
            return ptr::null_mut();
        }

        let c_path = match CStr::from_ptr(path).to_str() {
            Ok(s) => s,
            Err(_) => return ptr::null_mut(),
        };

        cfg_if::cfg_if! {
                if #[cfg(unix)] {
                    let fd = open(c_path.as_ptr() as *const i8, libc::O_RDONLY);
                    if fd < 0 {
                        return ptr::null_mut();
                    }

                    let size = lseek(fd, 0, SEEK_END);
                    if size < 0 {
                        close(fd);
                        return ptr::null_mut();
                    }
                    *len_out = size as usize;

                    let addr = mmap(
                        ptr::null_mut(),
                        *len_out,
                        PROT_READ,
                        MAP_PRIVATE,
                        fd,
                        0
                    );

                    close(fd);

                    if addr == libc::MAP_FAILED {
                        return ptr::null_mut();
                    }

                    addr
                } else if #[cfg(windows)] {
            // Convert Rust &str -> null-terminated C string
            let c_path_bytes = std::ffi::CString::new(c_path).unwrap();

            // Open file
            let h_file: HANDLE = CreateFileA(
                c_path_bytes.as_ptr() as *const u8,
                FILE_GENERIC_READ,
                FILE_SHARE_READ,
                ptr::null_mut(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                ptr::null_mut(),
            );

            if h_file == INVALID_HANDLE_VALUE {
                return ptr::null_mut();
            }

            let mut size: i64 = 0;
            if GetFileSizeEx(h_file, &mut size) == 0 {
                CloseHandle(h_file);
                return ptr::null_mut();
            }
            *len_out = size as usize;

            // Create file mapping
            let h_map: HANDLE = CreateFileMappingA(
                h_file,
                ptr::null_mut(),
                PAGE_READONLY,
                0,
                0,
                ptr::null(),
            );
            CloseHandle(h_file);

            if h_map.is_null() {
                return ptr::null_mut();
            }

            // Map view
            let addr: MEMORY_MAPPED_VIEW_ADDRESS = MapViewOfFile(
                h_map,
                FILE_MAP_READ,
                0,
                0,
                0,
            );
            CloseHandle(h_map);

            if addr.Value.is_null() {
                return ptr::null_mut();
            }

            addr.Value
        }
            }
    }
}

/// Unmaps a previously mapped file.
///
/// Safety: `ptr` must be a pointer returned by `mmap_open`
/// with the same `length` provided by that call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mmap_close(ptr: *mut c_void, _length: usize) {
    unsafe {
        if ptr.is_null() {
            return;
        }

        cfg_if::cfg_if! {
            if #[cfg(unix)] {
                munmap(ptr, _length);
            } else if #[cfg(windows)] {
                let view_addr = MEMORY_MAPPED_VIEW_ADDRESS { Value: ptr };
                UnmapViewOfFile(view_addr);
            }
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn mmap_open_write(path: *const c_char, len_out: *mut usize) -> *mut c_void {
    unsafe {
        if path.is_null() || len_out.is_null() {
            return ptr::null_mut();
        }

        let c_path = match CStr::from_ptr(path).to_str() {
            Ok(s) => s,
            Err(_) => return ptr::null_mut(),
        };

        cfg_if::cfg_if! {
            if #[cfg(unix)] {
                use libc::{ftruncate, O_RDWR, O_CREAT};

                let fd = open(c_path.as_ptr() as *const i8, O_RDWR | O_CREAT, 0o644);
                if fd < 0 {
                    return ptr::null_mut();
                }

                // If file is empty, pre-allocate 1MB by default (can adjust)
                let size = lseek(fd, 0, SEEK_END);
                let target_size = if size == 0 { 1024 * 1024 } else { size as usize };

                if ftruncate(fd, target_size as i64) != 0 {
                    close(fd);
                    return ptr::null_mut();
                }

                *len_out = target_size;

                let addr = mmap(
                    ptr::null_mut(),
                    *len_out,
                    libc::PROT_READ | libc::PROT_WRITE,
                    libc::MAP_SHARED,
                    fd,
                    0
                );

                close(fd);

                if addr == libc::MAP_FAILED {
                    return ptr::null_mut();
                }

                addr
            } else if #[cfg(windows)] {
                use windows_sys::Win32::Storage::FileSystem::{SetFilePointerEx, SetEndOfFile, FILE_GENERIC_WRITE};

                let c_path_bytes = std::ffi::CString::new(c_path).unwrap();
                let h_file: HANDLE = CreateFileA(
                    c_path_bytes.as_ptr() as *const u8,
                    FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                    FILE_SHARE_READ,
                    ptr::null_mut(),
                    OPEN_ALWAYS, // Create if not exists
                    FILE_ATTRIBUTE_NORMAL,
                    ptr::null_mut(),
                );

                if h_file == INVALID_HANDLE_VALUE {
                    return ptr::null_mut();
                }

                // Determine file size
                let mut size: i64 = 0;
                GetFileSizeEx(h_file, &mut size);
                let target_size = if size == 0 { 1024 * 1024 } else { size as usize };

                // Expand if needed
                let pos: i64 = target_size as i64;
                if SetFilePointerEx(h_file, pos, ptr::null_mut(), 0) == 0 || SetEndOfFile(h_file) == 0 {
                    CloseHandle(h_file);
                    return ptr::null_mut();
                }

                *len_out = target_size;

                let h_map: HANDLE = CreateFileMappingA(
                    h_file,
                    ptr::null_mut(),
                    windows_sys::Win32::System::Memory::PAGE_READWRITE,
                    0,
                    0,
                    ptr::null(),
                );
                CloseHandle(h_file);

                if h_map.is_null() {
                    return ptr::null_mut();
                }

                let addr: MEMORY_MAPPED_VIEW_ADDRESS = MapViewOfFile(
                    h_map,
                    windows_sys::Win32::System::Memory::FILE_MAP_WRITE,
                    0,
                    0,
                    0,
                );
                CloseHandle(h_map);

                if addr.Value.is_null() {
                    return ptr::null_mut();
                }

                addr.Value
            }
        }
    }
}

/// Write `len` bytes from `src_ptr` into (dst_ptr + offset).
/// Returns number of bytes written, or 0 on invalid args.
/// Safety: caller must ensure mapping is large enough for [offset, offset+len).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mmap_write(
    dst_ptr: *mut core::ffi::c_void,
    offset: usize,
    src_ptr: *const u8,
    len: usize,
) -> usize {
    unsafe {
        if dst_ptr.is_null() || src_ptr.is_null() || len == 0 {
            return 0;
        }
        let dst = (dst_ptr as *mut u8).add(offset);
        core::ptr::copy_nonoverlapping(src_ptr, dst, len);
        len
    }
}

/// Copies `len` bytes from (src_base + offset) into `dst_ptr`.
/// Returns number of bytes copied (len) or 0 on invalid args.
///
/// Safety:
/// - `src_base` must be a valid pointer returned by mmap_open / mmap_open_write(_with_size).
/// - The mapping must be at least `offset + len` bytes long.
/// - `dst_ptr` must point to a valid, writable buffer of size >= `len`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mmap_read(
    dst_ptr: *mut u8,
    src_base: *const core::ffi::c_void,
    offset: usize,
    len: usize,
) -> usize {
    unsafe {
        if dst_ptr.is_null() || src_base.is_null() || len == 0 {
            return 0;
        }
        let src = (src_base as *const u8).add(offset);
        core::ptr::copy_nonoverlapping(src, dst_ptr, len);
        len
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn mmap_flush(
    base_ptr: *mut core::ffi::c_void,
    offset: usize,
    len: usize,
) -> i32 {
    unsafe {
        if base_ptr.is_null() || len == 0 {
            return -1;
        }
        #[cfg(unix)]
        {
            use libc::{MS_SYNC, msync};
            let p = (base_ptr as *mut u8).add(offset) as *mut core::ffi::c_void;
            let rc = msync(p, len, MS_SYNC);
            return if rc == 0 { 0 } else { -1 };
        }
        #[cfg(windows)]
        {
            use core::ffi::c_void;
            use windows_sys::Win32::System::Memory::FlushViewOfFile;
            let p = (base_ptr as *const u8).add(offset) as *const c_void;
            let ok = FlushViewOfFile(p, len);
            return if ok != 0 { 0 } else { -1 };
        }
    }
}

/// Open (or create) a file and map it read-write, ensuring file size >= `size` if `size > 0`.
/// Writes the final mapped length to `len_out`. Returns pointer to mapping or null on failure.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mmap_open_write_with_size(
    path: *const core::ffi::c_char,
    len_out: *mut usize,
    size: usize,
) -> *mut core::ffi::c_void {
    unsafe {
        use core::ptr;
        if path.is_null() || len_out.is_null() {
            return ptr::null_mut();
        }

        let c_path = match core::ffi::CStr::from_ptr(path).to_str() {
            Ok(s) => s,
            Err(_) => return ptr::null_mut(),
        };

        #[cfg(unix)]
        {
            use libc::{
                MAP_SHARED, O_CREAT, O_RDWR, PROT_READ, PROT_WRITE, SEEK_END, close, ftruncate,
                lseek, mmap, open,
            };
            let fd = open(c_path.as_ptr() as *const i8, O_RDWR | O_CREAT, 0o644);
            if fd < 0 {
                return ptr::null_mut();
            }

            let cur = lseek(fd, 0, SEEK_END);
            if cur < 0 {
                close(fd);
                return ptr::null_mut();
            }

            let target = if size > 0 { size } else { cur as usize };

            let target = if target == 0 { 1024 * 1024 } else { target };

            if (cur as usize) < target {
                if ftruncate(fd, target as i64) != 0 {
                    close(fd);
                    return ptr::null_mut();
                }
            }
            *len_out = target;

            let addr = mmap(
                ptr::null_mut(),
                *len_out,
                PROT_READ | PROT_WRITE,
                MAP_SHARED,
                fd,
                0,
            );
            close(fd);
            if addr == libc::MAP_FAILED {
                return ptr::null_mut();
            }
            addr
        }

        #[cfg(windows)]
        {
            use core::ptr;
            use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
            use windows_sys::Win32::Storage::FileSystem::{
                CreateFileA, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
                FILE_SHARE_READ, GetFileSizeEx, OPEN_ALWAYS, SetEndOfFile, SetFilePointerEx,
            };
            use windows_sys::Win32::System::Memory::{
                CreateFileMappingA, FILE_MAP_WRITE, MEMORY_MAPPED_VIEW_ADDRESS, MapViewOfFile,
                PAGE_READWRITE,
            };

            let c_path_bytes = std::ffi::CString::new(c_path).unwrap();
            let h_file: HANDLE = CreateFileA(
                c_path_bytes.as_ptr() as *const u8,
                FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                FILE_SHARE_READ,
                ptr::null_mut(),
                OPEN_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                ptr::null_mut(),
            );
            if h_file == INVALID_HANDLE_VALUE {
                return ptr::null_mut();
            }

            let mut cur: i64 = 0;
            let _ = GetFileSizeEx(h_file, &mut cur);

            let mut target = if size > 0 { size as i64 } else { cur };
            if target == 0 {
                target = 1024 * 1024;
            } // default 1 MiB

            if cur < target {
                // extend file to target
                if SetFilePointerEx(h_file, target, ptr::null_mut(), 0) == 0
                    || SetEndOfFile(h_file) == 0
                {
                    CloseHandle(h_file);
                    return ptr::null_mut();
                }
            }
            *len_out = target as usize;

            let h_map: HANDLE =
                CreateFileMappingA(h_file, ptr::null_mut(), PAGE_READWRITE, 0, 0, ptr::null());
            CloseHandle(h_file);
            if h_map.is_null() {
                return ptr::null_mut();
            }

            let addr: MEMORY_MAPPED_VIEW_ADDRESS = MapViewOfFile(h_map, FILE_MAP_WRITE, 0, 0, 0);
            CloseHandle(h_map);
            if addr.Value.is_null() {
                return ptr::null_mut();
            }
            addr.Value
        }
    }
}
