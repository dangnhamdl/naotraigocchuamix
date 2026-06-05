# NKTg AI Pipeline Production Engine

Đây là hệ thống lõi (core engine) được thiết kế cho NKTg AI, tập trung vào khả năng xử lý thông tin thông minh, điều hướng logic và tối ưu hóa phản hồi hệ thống.

## Tổng quan hệ thống
Hệ thống sử dụng kiến trúc pipeline phân tầng để đảm bảo tính ổn định và tốc độ xử lý cho các tiến trình AI phức tạp.

- **Encoder:** Xử lý mã hóa dữ liệu đầu vào.
- **Geo-Routing:** Điều hướng yêu cầu thông minh dựa trên vị trí/bối cảnh.
- **Fallback Chain:** Cơ chế dự phòng đảm bảo hệ thống luôn phản hồi trong mọi tình huống.
- **RAG Layer:** Tích hợp kiến trúc RAG để truy xuất thông tin chính xác.
- **Cache Layer:** Tối ưu hóa hiệu năng bằng bộ nhớ đệm thông minh.
- **Kernel:** Nhân xử lý chính, điều phối toàn bộ luồng hoạt động.
- **Distributed Sync:** Đồng bộ hóa dữ liệu phân tán.

## Cấu trúc dự án
- `index.html`: Giao diện chính của hệ thống.
- `main.js`: File điều khiển trung tâm (Orchestrator).
- Các file `step-x-*.js`: Các module thực thi từng giai đoạn của pipeline.

## Hướng dẫn sử dụng
1. Clone dự án về máy hoặc tải lên GitHub.
2. Kích hoạt GitHub Pages từ nhánh `main` để chạy web ứng dụng.
3. Mở Console (F12) để theo dõi luồng hoạt động của NKTg AI Engine trong thời gian thực.

## Giấy phép
Dự án được quản lý nội bộ bởi NKTg AI Team.