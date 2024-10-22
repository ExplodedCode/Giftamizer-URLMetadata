const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>URL Fetcher</title>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/mdb-ui-kit/4.3.0/mdb.min.css" rel="stylesheet">
    <style>
        .loading-spinner {
            border: 4px solid #f3f3f3; /* Light grey */
            border-top: 4px solid #007bff; /* Bootstrap primary blue */
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .response-container {
            margin-top: 20px;
        }

        img {
            margin-right: 10px;
            margin-bottom: 10px;
        }
    </style>
</head>
<body>
    <div class="container py-5">
        <h1 class="mb-4">Enter a URL to Fetch</h1>
        <div class="form-outline mb-4">
            <input type="text" id="urlInput" class="form-control" placeholder="Enter URL here" value="https://picsum.photos" />
        </div>
        <button onclick="fetchData()" class="btn btn-primary btn-lg mb-3">Send</button>
        <div id="loading" class="loading-spinner" style="display: none;"></div>

        <div class="response-container">
            <div id="title"></div>
            <div id="description"></div>
            <div id="price"></div>
            <div id="images"></div>
        </div>
    </div>

    <script>
        function fetchData() {
            const url = document.getElementById('urlInput').value;
            const loadingElement = document.getElementById('loading');
            const title = document.getElementById('title');
            const description = document.getElementById('description');
            const price = document.getElementById('price');
            const imagesDiv = document.getElementById('images');

            loadingElement.style.display = 'block';
            title.innerHTML = '';
            description.innerHTML = '';
            price.innerHTML = '';
            imagesDiv.innerHTML = '';

            fetch('/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ url: url })
            }).then(response => response.json())
              .then(data => {
                try {
                    loadingElement.style.display = 'none';
                    title.innerHTML = \`<b>Title:</b> \${data?.title ?? 'N/A'}\`;
                    description.innerHTML = \`<b>Description:</b> \${data?.description ?? 'N/A'}\`;
                    price.innerHTML = \`<b>Price:</b> \${data?.price ?? 'N/A'}\`;
                    
                    imagesDiv.innerHTML = ''; // Clear previous images
                    data.images.forEach(img => {
                        imagesDiv.innerHTML += \`<img src="\${img}" style="max-width: 200px; max-height: 200px;" />\`;
                    });
                    console.log('Data:', data);
                } catch (e) {
                    loadingElement.style.display = 'none';
                    title.innerHTML = '<b>Error:</b> ' + data.error;
                    description.innerHTML = '';
                    price.innerHTML = '';
                    imagesDiv.innerHTML = '';
                    console.error('Error:', data.error, e, data);
                }
              })
              .catch(error => {
                loadingElement.style.display = 'none';
                title.innerHTML = '<b>Error:</b> ' + error;
                description.innerHTML = '';
                price.innerHTML = '';
                imagesDiv.innerHTML = '';
                console.error('Error:', error, response);
              });
        }
    </script>

    <script src="https://cdnjs.cloudflare.com/ajax/libs/mdb-ui-kit/4.3.0/mdb.min.js"></script>
</body>
</html>`;

export default html;
